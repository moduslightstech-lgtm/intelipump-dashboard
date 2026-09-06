package com.fuelops.mqtt;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fuelops.alerts.Alert;
import com.fuelops.alerts.AlertRepository;
import com.fuelops.ingestion.IngestionService;
import com.fuelops.ingestion.RawEvent;
import com.fuelops.reporting.PumpTransaction;
import com.fuelops.reporting.PumpTransactionRepository;
import com.fuelops.sse.SseEmitterRegistry;
import com.fuelops.statemachine.StationStateMachineService;
import com.fuelops.statemachine.StationStateMachineService.EventKind;
import com.fuelops.statemachine.StationStateMachineService.MachineEvent;
import com.fuelops.tenancy.*;
import com.fuelops.twin.TankExpectedStateService;
import com.fuelops.twin.TwinStateService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Component
@RequiredArgsConstructor
@Slf4j
public class MqttMessageHandler {

    private final IngestionService ingestionService;
    private final TankExpectedStateService tankExpectedStateService;
    private final StationStateMachineService stateMachineService;
    private final TwinStateService twinStateService;
    private final SseEmitterRegistry sseEmitterRegistry;
    private final ObjectMapper objectMapper;

    // Repositories for dynamic bootstrapping and price mismatch auditing
    private final StationRepository stationRepository;
    private final PumpRepository pumpRepository;
    private final NozzleRepository nozzleRepository;
    private final ProductRepository productRepository;
    private final TankRepository tankRepository;
    private final AlertRepository alertRepository;
    private final PumpTransactionRepository pumpTransactionRepository;

    private static final UUID DEFAULT_TENANT_ID = UUID.fromString("00000000-0000-0000-0000-000000000000");

    public void handle(String topic, String rawPayload) {
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> payload = objectMapper.readValue(rawPayload, Map.class);
            
            // Extract external keys
            String externalStationId = getPayloadString(payload, "stationId");
            if (externalStationId == null) {
                log.warn("Missing stationId in MQTT payload: {}", rawPayload);
                return;
            }

            // 1. Resolve or Bootstrap Station
            Station station = stationRepository.findByTenantIdAndExternalId(DEFAULT_TENANT_ID, externalStationId)
                    .orElseGet(() -> {
                        log.info("Auto-bootstrapping unrecognized station external_id={}", externalStationId);
                        Station newStation = new Station();
                        newStation.setTenantId(DEFAULT_TENANT_ID);
                        newStation.setName(externalStationId.replace("-", " "));
                        newStation.setExternalId(externalStationId);
                        newStation.setLocation("Auto Bootstrapped Node");
                        newStation.setStatus("ONLINE");
                        newStation.setLastSeenAt(Instant.now());
                        return stationRepository.save(newStation);
                    });

            // Update station last seen
            Instant deviceTime = payload.containsKey("timestamp")
                    ? Instant.parse(payload.get("timestamp").toString())
                    : Instant.now();
            station.setLastSeenAt(Instant.now());
            stationRepository.save(station);

            // Determine dynamic handler by event suffix or payload type
            String eventType = topic.substring(topic.lastIndexOf("/") + 1).toUpperCase();
            
            if ("TANK_READING".equals(eventType) || payload.containsKey("reportedLiters")) {
                handleTankReading(topic, payload, station, deviceTime);
            } else {
                handleTransaction(topic, payload, station, deviceTime);
            }

        } catch (Exception e) {
            log.error("Failed to process incoming MQTT payload on {}: {}", topic, e.getMessage(), e);
        }
    }

    private void handleTransaction(String topic, Map<String, Object> payload, Station station, Instant deviceTime) {
        try {
            String txId = getPayloadString(payload, "transactionId");
            if (txId == null) {
                log.warn("Missing transactionId in transaction payload");
                return;
            }

            // Deduplication
            if (pumpTransactionRepository.existsById(txId)) {
                log.debug("Duplicate transaction id={} ignored", txId);
                return;
            }

            String externalPumpId = getPayloadString(payload, "pumpId");
            String externalNozzleId = getPayloadString(payload, "nozzleId");
            String productCode = getPayloadString(payload, "product");
            BigDecimal volume = getPayloadDecimal(payload, "volumeLiters");
            BigDecimal amount = getPayloadDecimal(payload, "amount");
            String currency = getPayloadString(payload, "currency");
            BigDecimal price = getPayloadDecimal(payload, "pricePerLiter");

            if (externalPumpId == null || externalNozzleId == null || productCode == null || volume == null) {
                log.warn("Malformed transaction payload fields");
                return;
            }

            // 2. Resolve or Bootstrap Pump
            Pump pump = pumpRepository.findByStationIdAndExternalId(station.getId(), externalPumpId)
                    .orElseGet(() -> {
                        log.info("Auto-bootstrapping pump external_id={} on station={}", externalPumpId, station.getName());
                        Pump newPump = new Pump();
                        newPump.setTenantId(station.getTenantId());
                        newPump.setStationId(station.getId());
                        newPump.setLabel(externalPumpId.replace("-", " "));
                        newPump.setExternalId(externalPumpId);
                        newPump.setStatus("IDLE");
                        newPump.setLastSeenAt(Instant.now());
                        return pumpRepository.save(newPump);
                    });
            pump.setStatus("IDLE");
            pump.setLastSeenAt(Instant.now());
            pumpRepository.save(pump);

            // 3. Resolve or Bootstrap Product
            final BigDecimal initialPrice = price;
            Product product = productRepository.findByTenantIdAndCode(station.getTenantId(), productCode)
                    .orElseGet(() -> {
                        log.info("Auto-bootstrapping product code={}", productCode);
                        Product newProduct = new Product();
                        newProduct.setTenantId(station.getTenantId());
                        newProduct.setCode(productCode);
                        newProduct.setName(productCode + " Fuel");
                        newProduct.setUnitPrice(initialPrice != null ? initialPrice : BigDecimal.valueOf(1150.00));
                        return productRepository.save(newProduct);
                    });

            // 4. Resolve or Bootstrap Nozzle
            Nozzle nozzle = nozzleRepository.findByPumpIdAndExternalId(pump.getId(), externalNozzleId)
                    .orElseGet(() -> {
                        log.info("Auto-bootstrapping nozzle external_id={} on pump={}", externalNozzleId, pump.getLabel());
                        Nozzle newNozzle = new Nozzle();
                        newNozzle.setTenantId(station.getTenantId());
                        newNozzle.setStationId(station.getId());
                        newNozzle.setPumpId(pump.getId());
                        newNozzle.setProductId(product.getId());
                        newNozzle.setLabel(externalNozzleId.replace("-", " "));
                        newNozzle.setExternalId(externalNozzleId);
                        return nozzleRepository.save(newNozzle);
                    });

            // 5. Audit Transaction Prices
            if (price == null && volume.compareTo(BigDecimal.ZERO) > 0 && amount != null) {
                price = amount.divide(volume, 2, RoundingMode.HALF_UP);
            }
            if (amount == null && volume != null && price != null) {
                amount = volume.multiply(price).setScale(2, RoundingMode.HALF_UP);
            }
            if (price == null) {
                price = product.getUnitPrice();
            }
            if (amount == null) {
                amount = volume.multiply(price).setScale(2, RoundingMode.HALF_UP);
            }

            BigDecimal expectedPrice = product.getUnitPrice();
            if (price.compareTo(expectedPrice) != 0) {
                log.warn("Price mismatch detected on transaction={}! Received: {}, Expected: {}", txId, price, expectedPrice);
                Alert priceAlert = new Alert();
                priceAlert.setTenantId(station.getTenantId());
                priceAlert.setStationId(station.getId());
                priceAlert.setAlertType("PRICE_MISMATCH");
                priceAlert.setSeverity("CRITICAL");
                priceAlert.setTitle("Dispenser Unit Price Audit Mismatch");
                priceAlert.setStatus("OPEN");
                priceAlert.setTriggeredAt(Instant.now());

                Map<String, Object> details = new HashMap<>();
                details.put("transactionId", txId);
                details.put("pumpId", externalPumpId);
                details.put("reportedPrice", price);
                details.put("expectedPrice", expectedPrice);
                details.put("message", String.format("Transaction %s on pump %s reported %s/L but master product configuration specifies %s/L",
                        txId, externalPumpId, price, expectedPrice));
                priceAlert.setDetails(details);
                alertRepository.save(priceAlert);

                // Broadcast alert event over SSE
                sseEmitterRegistry.broadcast(station.getId(), "alert-created", priceAlert);
            }

            // 6. Persist Transaction
            PumpTransaction tx = new PumpTransaction();
            tx.setId(txId);
            tx.setTenantId(station.getTenantId());
            tx.setStationId(station.getId().toString());
            tx.setPumpId(pump.getId().toString());
            tx.setNozzleId(nozzle.getId().toString());
            tx.setProduct(productCode);
            tx.setVolumeLiters(volume);
            tx.setAmount(amount);
            tx.setCurrency(currency != null ? currency : "NGN");
            tx.setPricePerLiter(price);
            tx.setRawFrame(payload.getOrDefault("rawFrame", "").toString());
            tx.setStatus("COMPLETED");
            tx.setSourceTopic(topic);
            tx.setDeviceTimestamp(deviceTime);
            tx.setReceivedAt(Instant.now());
            pumpTransactionRepository.save(tx);

            // Feed existing RawEvent pipeline for backward reconciliation and expected state tracking
            try {
                RawEvent rawEvent = new RawEvent();
                rawEvent.setTenantId(station.getTenantId());
                rawEvent.setStationId(station.getId());
                rawEvent.setSource("MQTT_REAL");
                rawEvent.setEventId(txId);
                rawEvent.setEventType("FUEL_DISPENSE");

                Map<String, Object> rawPayload = new HashMap<>();
                rawPayload.put("nozzleId", nozzle.getId().toString());
                rawPayload.put("pumpId", pump.getId().toString());
                rawPayload.put("liters", volume);
                rawPayload.put("unitPrice", price);
                rawPayload.put("totalAmount", amount);
                rawPayload.put("shiftId", "LIVE");

                // Look up corresponding tank to pass to the expected state engine
                final Product finalProduct = product;
                tankRepository.findByStationId(station.getId()).stream()
                        .filter(t -> t.getProductId().equals(finalProduct.getId()))
                        .findFirst()
                        .ifPresent(tank -> rawPayload.put("tankId", tank.getId().toString()));

                rawEvent.setPayload(rawPayload);
                rawEvent.setDeviceTime(deviceTime);
                rawEvent.setReceivedTime(Instant.now());
                ingestionService.ingest(rawEvent);
            } catch (Exception e) {
                log.error("Failed to route transaction into raw event pipeline: {}", e.getMessage());
            }

            // Broadcast to SSE
            Map<String, Object> ssePayload = new LinkedHashMap<>();
            ssePayload.put("transactionId", txId);
            ssePayload.put("stationId", station.getExternalId());
            ssePayload.put("pumpId", pump.getExternalId());
            ssePayload.put("nozzleId", nozzle.getExternalId());
            ssePayload.put("product", productCode);
            ssePayload.put("volumeLiters", volume.doubleValue());
            ssePayload.put("amount", amount.doubleValue());
            ssePayload.put("pricePerLiter", price.doubleValue());
            ssePayload.put("status", "COMPLETED");
            ssePayload.put("timestamp", deviceTime.toString());

            sseEmitterRegistry.broadcast(station.getId(), "transaction-completed", ssePayload);

            // Update state machine triggers
            stateMachineService.transition(station.getTenantId(), station.getId(), MachineEvent.EVENT_RECEIVED, EventKind.DISPENSE);

        } catch (Exception e) {
            log.error("Failed to digest completed dispenser transaction payload: {}", e.getMessage(), e);
        }
    }

    private void handleTankReading(String topic, Map<String, Object> payload, Station station, Instant deviceTime) {
        try {
            String externalTankId = getPayloadString(payload, "tankId");
            BigDecimal reportedLiters = getPayloadDecimal(payload, "reportedLiters");
            if (externalTankId == null || reportedLiters == null) {
                log.warn("Missing fields in tank reading payload");
                return;
            }

            // Resolve corresponding tank
            List<Tank> tanks = tankRepository.findByStationId(station.getId());
            final String targetTankId = externalTankId;
            Tank matchingTank = tanks.stream()
                    .filter(t -> t.getLabel().contains(targetTankId) || t.getId().toString().equals(targetTankId))
                    .findFirst()
                    .orElse(tanks.isEmpty() ? null : tanks.get(0));

            if (matchingTank == null) {
                log.warn("No matching tank found for externalId={}", externalTankId);
                return;
            }

            // Anchor Expected State immediately from reading
            try {
                tankExpectedStateService.anchorFromReading(station.getTenantId(), station.getId(), matchingTank.getId(), reportedLiters);
            } catch (Exception e) {
                log.warn("Failed to anchor expected tank state: {}", e.getMessage());
            }

            // Broadcast tank status event
            Map<String, Object> ssePayload = new LinkedHashMap<>();
            ssePayload.put("tankId", externalTankId);
            ssePayload.put("reportedLiters", reportedLiters.doubleValue());
            ssePayload.put("timestamp", deviceTime.toString());

            sseEmitterRegistry.broadcast(station.getId(), "tank-reading", ssePayload);

            // Update state machine
            stateMachineService.transition(station.getTenantId(), station.getId(), MachineEvent.EVENT_RECEIVED, EventKind.TANK_READING);

        } catch (Exception e) {
            log.error("Failed to digest tank reading payload: {}", e.getMessage(), e);
        }
    }

    private String getPayloadString(Map<String, Object> payload, String key) {
        Object val = payload.get(key);
        return val != null ? val.toString() : null;
    }

    private BigDecimal getPayloadDecimal(Map<String, Object> payload, String key) {
        Object val = payload.get(key);
        if (val == null) return null;
        try {
            return new BigDecimal(val.toString());
        } catch (Exception e) {
            return null;
        }
    }
}
