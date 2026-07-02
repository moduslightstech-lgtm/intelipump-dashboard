package com.fuelops.simulator;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fuelops.tenancy.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.eclipse.paho.client.mqttv3.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

/**
 * MQTT Simulator — runs only when SPRING_PROFILES_ACTIVE=simulator
 *
 * Publishes to:
 * fuelops/{tenantId}/{stationId}/dispense
 * fuelops/{tenantId}/{stationId}/tank-reading
 * fuelops/{tenantId}/{stationId}/payment
 * fuelops/{tenantId}/{stationId}/status
 *
 * Demo scenarios (per station):
 * Station 0: normal operation (ONLINE)
 * Station 1: random data gaps (DATA_GAP)
 * Station 2: POS delays + cash leakage (ALERTING)
 */
@Component
@Profile("simulator")
@RequiredArgsConstructor
@Slf4j
public class MqttSimulator implements ApplicationRunner {

    private final TenantRepository tenantRepository;
    private final StationRepository stationRepository;
    private final TankRepository tankRepository;
    private final PumpRepository pumpRepository;
    private final NozzleRepository nozzleRepository;
    private final ObjectMapper objectMapper;

    @Value("${mqtt.broker-url:tcp://localhost:1883}")
    private String brokerUrl;

    @Value("${DISPENSE_MIN_SEC:5}")
    private int dispenseMinSec;
    @Value("${DISPENSE_MAX_SEC:12}")
    private int dispenseMaxSec;

    @Value("${TANK_MIN_SEC:30}")
    private int tankMinSec;
    @Value("${TANK_MAX_SEC:60}")
    private int tankMaxSec;

    @Value("${PAYMENT_MIN_SEC:120}")
    private int paymentMinSec;
    @Value("${PAYMENT_MAX_SEC:300}")
    private int paymentMaxSec;

    @Value("${GAP_MIN_SEC:120}")
    private int gapMinSec;
    @Value("${GAP_MAX_SEC:300}")
    private int gapMaxSec;

    @Value("${POS_DELAY_PROBABILITY:0.2}")
    private double posDelayProb;

    private final Random rng = new Random();
    private MqttClient mqttClient;
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(4);

    // Track simulated tank volumes per tankId
    private final Map<UUID, BigDecimal> simulatedVolumes = new ConcurrentHashMap<>();

    @Override
    public void run(ApplicationArguments args) throws Exception {
        // Connect to MQTT
        mqttClient = new MqttClient(brokerUrl, "fuelops-simulator-" + UUID.randomUUID().toString().substring(0, 8),
                null);
        MqttConnectOptions opts = new MqttConnectOptions();
        opts.setAutomaticReconnect(true);
        opts.setCleanSession(true);

        int retries = 10;
        while (retries-- > 0) {
            try {
                mqttClient.connect(opts);
                log.info("Simulator connected to MQTT broker at {}", brokerUrl);
                break;
            } catch (MqttException e) {
                log.warn("Simulator waiting for MQTT broker... ({} retries left)", retries);
                Thread.sleep(3000);
            }
        }

        if (!mqttClient.isConnected()) {
            log.error("Could not connect to MQTT broker. Simulator exiting.");
            return;
        }

        // Load all stations from all tenants
        List<Tenant> tenants = tenantRepository.findAll();
        if (tenants.isEmpty()) {
            log.warn("No tenants found in DB. Simulator has nothing to simulate.");
            return;
        }

        List<SimStation> simStations = new ArrayList<>();
        for (Tenant tenant : tenants) {
            List<Station> stations = stationRepository.findByTenantId(tenant.getId());
            for (int i = 0; i < stations.size(); i++) {
                Station station = stations.get(i);
                SimStation sim = new SimStation();
                sim.tenantId = tenant.getId();
                sim.stationId = station.getId();
                sim.tanks = tankRepository.findByStationId(station.getId());
                sim.pumps = pumpRepository.findByStationId(station.getId());
                sim.nozzles = new ArrayList<>();
                for (Pump p : sim.pumps) {
                    sim.nozzles.addAll(nozzleRepository.findByPumpId(p.getId()));
                }
                sim.scenarioIndex = i % 3;
                // Init simulated volumes
                for (Tank t : sim.tanks) {
                    simulatedVolumes.put(t.getId(),
                            t.getCapacityLiters().multiply(BigDecimal.valueOf(0.75)));
                }
                simStations.add(sim);
            }
        }

        for (SimStation sim : simStations) {
            sim.nextDataGapTime = Instant.now().plusSeconds(600 + rng.nextInt(601)); // 10-20 mins
            scheduleNextDispense(sim);
            scheduleNextTankReading(sim);
            scheduleNextPayment(sim);
        }

        log.info("Simulator running: {} stations with dynamic scheduling configuration.", simStations.size());
    }

    private void scheduleNextDispense(SimStation sim) {
        long delayMs;
        if (Instant.now().isBefore(sim.gapEndTime)) {
            delayMs = Math.max(1000, sim.gapEndTime.toEpochMilli() - Instant.now().toEpochMilli());
        } else if (Instant.now().isAfter(sim.nextDataGapTime)) {
            int gapSec = gapMinSec + rng.nextInt(gapMaxSec - gapMinSec + 1);
            sim.gapEndTime = Instant.now().plusSeconds(gapSec);
            sim.nextDataGapTime = Instant.now().plusSeconds(600 + rng.nextInt(601)); // Next gap in 10-20 mins
            log.info("Station {} entering simulated data gap for {}s", sim.stationId, gapSec);
            try { publishStatus(sim, "DATA_GAP", "Simulated telemetry gap"); } catch (Exception e) {}
            delayMs = gapSec * 1000L;
            
            scheduler.schedule(() -> {
                try { publishStatus(sim, "ONLINE", "Telemetry restored"); } catch (Exception e) {}
            }, delayMs, TimeUnit.MILLISECONDS);
        } else if (Instant.now().isBefore(sim.quietEndTime)) {
            delayMs = Math.max(1000, sim.quietEndTime.toEpochMilli() - Instant.now().toEpochMilli());
        } else if (sim.burstRemaining > 0) {
            sim.burstRemaining--;
            delayMs = 1000 + rng.nextInt(2000); // 1-3 seconds between burst events
        } else {
            delayMs = (dispenseMinSec + rng.nextInt(dispenseMaxSec - dispenseMinSec + 1)) * 1000L;
            
            double roll = rng.nextDouble();
            if (roll < 0.05) { // 5% chance quiet
                int quietSec = 30 + rng.nextInt(31);
                sim.quietEndTime = Instant.now().plusSeconds(quietSec);
                delayMs = quietSec * 1000L;
            } else if (roll < 0.10) { // 5% chance burst
                sim.burstRemaining = 2 + rng.nextInt(3); // 2-4 additional events (3-5 total)
                delayMs = 1000 + rng.nextInt(2000); 
            }
        }
        
        scheduler.schedule(() -> {
            try {
                if (Instant.now().isAfter(sim.gapEndTime) && Instant.now().isAfter(sim.quietEndTime)) {
                    simulateDispense(sim);
                }
            } catch (Exception e) {
                log.error("Dispense sim error: {}", e.getMessage());
            } finally {
                scheduleNextDispense(sim);
            }
        }, delayMs, TimeUnit.MILLISECONDS);
    }

    private void scheduleNextTankReading(SimStation sim) {
        long delayMs = (tankMinSec + rng.nextInt(tankMaxSec - tankMinSec + 1)) * 1000L;
        scheduler.schedule(() -> {
            try {
                if (Instant.now().isAfter(sim.gapEndTime)) {
                    simulateTankReading(sim);
                }
            } catch (Exception e) {
                log.error("Tank reading sim error: {}", e.getMessage());
            } finally {
                scheduleNextTankReading(sim);
            }
        }, delayMs, TimeUnit.MILLISECONDS);
    }

    private void scheduleNextPayment(SimStation sim) {
        long delayMs = (paymentMinSec + rng.nextInt(paymentMaxSec - paymentMinSec + 1)) * 1000L;
        scheduler.schedule(() -> {
            try {
                if (Instant.now().isAfter(sim.gapEndTime)) {
                    simulatePayment(sim);
                }
            } catch (Exception e) {
                log.error("Payment sim error: {}", e.getMessage());
            } finally {
                scheduleNextPayment(sim);
            }
        }, delayMs, TimeUnit.MILLISECONDS);
    }

    private void simulatePayment(SimStation sim) throws Exception {
        boolean posDelay = sim.scenarioIndex == 2 && rng.nextDouble() < posDelayProb;
        if (posDelay) {
            log.debug("POS payment delayed for station {}", sim.stationId);
            return;
        }
        
        double amount = 5000 + rng.nextDouble() * 20000;
        String method = rng.nextDouble() < 0.5 ? "CASH" : "POS";
        double payAmount = (sim.scenarioIndex == 2 && "CASH".equals(method))
                ? amount * 0.83 // 17% leakage
                : amount;
        publishPayment(sim, method, payAmount);
    }

    private void simulateDispense(SimStation sim) throws Exception {
        if (sim.nozzles.isEmpty() || sim.tanks.isEmpty())
            return;

        Nozzle nozzle = sim.nozzles.get(rng.nextInt(sim.nozzles.size()));

        // Find the matching tank (same productId)
        Tank tank = sim.tanks.stream()
                .filter(t -> t.getProductId().equals(nozzle.getProductId()))
                .findFirst()
                .orElse(sim.tanks.get(0));

        double liters = 5 + rng.nextDouble() * 45; // 5–50 L
        double unitPrice = 617.0; // PMS default

        BigDecimal currentVol = simulatedVolumes.getOrDefault(tank.getId(), BigDecimal.valueOf(15000));
        if (currentVol.doubleValue() < liters) {
            liters = currentVol.doubleValue() * 0.5; // partial fill
        }
        simulatedVolumes.put(tank.getId(),
                currentVol.subtract(BigDecimal.valueOf(liters)).max(BigDecimal.ZERO));

        double amount = liters * unitPrice;
        String eventId = UUID.randomUUID().toString();

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("eventId", eventId);
        payload.put("eventType", "DISPENSE");
        payload.put("deviceTime", Instant.now().toString());
        payload.put("tenantId", sim.tenantId.toString());
        payload.put("stationId", sim.stationId.toString());
        payload.put("pumpId", nozzle.getPumpId().toString());
        payload.put("nozzleId", nozzle.getId().toString());
        payload.put("tankId", tank.getId().toString());
        payload.put("productCode", "PMS");
        payload.put("liters", round(liters));
        payload.put("unitPrice", unitPrice);
        payload.put("amount", round(amount));

        publish(sim.tenantId, sim.stationId, "dispense", payload);

        // Immediately publish a tank reading to keep the Reported liters in sync with dispenses
        publishTankReadingForTank(sim, tank);
    }
    
    private void publishTankReadingForTank(SimStation sim, Tank tank) throws Exception {
        BigDecimal vol = simulatedVolumes.getOrDefault(tank.getId(), BigDecimal.valueOf(15000));
        // Add small random noise
        double noise = (rng.nextGaussian() * 20);
        double reported = Math.max(0, vol.doubleValue() + noise);

        Map<String, Object> payload = new java.util.LinkedHashMap<>();
        payload.put("eventId", UUID.randomUUID().toString());
        payload.put("eventType", "TANK_READING");
        payload.put("deviceTime", Instant.now().toString());
        payload.put("tenantId", sim.tenantId.toString());
        payload.put("stationId", sim.stationId.toString());
        payload.put("tankId", tank.getId().toString());
        payload.put("productCode", "PMS");
        payload.put("reportedLiters", round(reported));

        publish(sim.tenantId, sim.stationId, "tank_reading", payload);
    }

    private void simulateTankReading(SimStation sim) throws Exception {
        for (Tank tank : sim.tanks) {
            BigDecimal vol = simulatedVolumes.getOrDefault(tank.getId(), BigDecimal.valueOf(15000));
            // Add small random noise
            double noise = (rng.nextGaussian() * 20);
            double reported = Math.max(0, vol.doubleValue() + noise);

            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("eventId", UUID.randomUUID().toString());
            payload.put("eventType", "TANK_READING");
            payload.put("deviceTime", Instant.now().toString());
            payload.put("tenantId", sim.tenantId.toString());
            payload.put("stationId", sim.stationId.toString());
            payload.put("tankId", tank.getId().toString());
            payload.put("productCode", "PMS");
            payload.put("reportedLiters", round(reported));

            publish(sim.tenantId, sim.stationId, "tank_reading", payload);
        }
    }

    private void publishPayment(SimStation sim, String method, double amount) throws Exception {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("eventId", UUID.randomUUID().toString());
        payload.put("eventType", "PAYMENT");
        payload.put("deviceTime", Instant.now().toString());
        payload.put("tenantId", sim.tenantId.toString());
        payload.put("stationId", sim.stationId.toString());
        payload.put("method", method);
        payload.put("amount", round(amount));
        payload.put("reference", "SIM-" + UUID.randomUUID().toString().substring(0, 6).toUpperCase());
        publish(sim.tenantId, sim.stationId, "payment", payload);
    }

    private void publishStatus(SimStation sim, String code, String message) throws Exception {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("eventId", UUID.randomUUID().toString());
        payload.put("eventType", "STATUS");
        payload.put("deviceTime", Instant.now().toString());
        payload.put("tenantId", sim.tenantId.toString());
        payload.put("stationId", sim.stationId.toString());
        payload.put("code", code);
        payload.put("message", message);
        publish(sim.tenantId, sim.stationId, "status", payload);
    }

    private void publish(UUID tenantId, UUID stationId, String type, Object payload) throws Exception {
        String topic = String.format("fuelops/%s/%s/%s", tenantId, stationId, type);
        String json = objectMapper.writeValueAsString(payload);
        MqttMessage msg = new MqttMessage(json.getBytes());
        msg.setQos(1);
        if (mqttClient.isConnected()) {
            mqttClient.publish(topic, msg);
        }
    }

    private double round(double v) {
        return BigDecimal.valueOf(v).setScale(2, RoundingMode.HALF_UP).doubleValue();
    }

    private static class SimStation {
        UUID tenantId;
        UUID stationId;
        List<Tank> tanks;
        List<Pump> pumps;
        List<Nozzle> nozzles;
        int scenarioIndex; // 0=normal, 1=data_gap, 2=cash_leakage+pos_delay
        Instant nextDataGapTime = Instant.now();
        Instant gapEndTime = Instant.MIN;
        int burstRemaining = 0;
        Instant quietEndTime = Instant.MIN;
    }
}
