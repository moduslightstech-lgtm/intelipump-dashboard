package com.fuelops.seed;

import com.fuelops.auth.AppUser;
import com.fuelops.auth.AppUserRepository;
import com.fuelops.ingestion.IngestionService;
import com.fuelops.ingestion.RawEvent;
import com.fuelops.normalization.PaymentEvent;
import com.fuelops.normalization.PaymentEventRepository;
import com.fuelops.reconciliation.ReconciliationEngine;
import com.fuelops.alerts.AlertEngine;
import com.fuelops.tenancy.*;
import com.fuelops.twin.TwinStateService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

@Service
@RequiredArgsConstructor
@Slf4j
public class SeedDataGenerator {

    private final TenantRepository tenantRepository;
    private final StationRepository stationRepository;
    private final ProductRepository productRepository;
    private final TankRepository tankRepository;
    private final PumpRepository pumpRepository;
    private final NozzleRepository nozzleRepository;
    private final AppUserRepository userRepository;
    private final IngestionService ingestionService;
    private final PaymentEventRepository paymentEventRepository;
    private final ReconciliationEngine reconciliationEngine;
    private final AlertEngine alertEngine;
    private final TwinStateService twinStateService;
    private final PasswordEncoder passwordEncoder;

    private final Random random = new Random(42);

    @Transactional
    public Map<String, Object> seed() {
        log.info("Starting seed data generation...");

        // Skip if already seeded
        if (tenantRepository.findBySlug("demo-tenant").isPresent()) {
            log.info("Seed data already exists, skipping.");
            return Map.of("status", "already_seeded");
        }

        Tenant tenant = createTenant();
        List<Product> products = createProducts(tenant);
        List<Station> stations = createStations(tenant, 3);
        Map<UUID, List<Tank>> tanksByStation = new LinkedHashMap<>();
        Map<UUID, List<Pump>> pumpsByStation = new LinkedHashMap<>();
        Map<UUID, Map<UUID, List<Nozzle>>> nozzlesByPump = new LinkedHashMap<>();

        for (Station station : stations) {
            tanksByStation.put(station.getId(), createTanks(tenant, station, products));
            List<Pump> pumps = createPumps(tenant, station, 4);
            pumpsByStation.put(station.getId(), pumps);
            Map<UUID, List<Nozzle>> nozzles = new LinkedHashMap<>();
            for (Pump pump : pumps) {
                nozzles.put(pump.getId(), createNozzles(tenant, station, pump, products));
            }
            nozzlesByPump.put(station.getId(), nozzles);
        }

        createUsers(tenant, stations);

        // Generate 7 days of events
        int totalEvents = 0;
        Instant now = Instant.now();
        for (int dayOffset = 6; dayOffset >= 0; dayOffset--) {
            LocalDate day = LocalDate.now(ZoneOffset.UTC).minusDays(dayOffset);
            Instant dayStart = day.atStartOfDay().toInstant(ZoneOffset.UTC);

            for (int si = 0; si < stations.size(); si++) {
                Station station = stations.get(si);
                List<Tank> tanks = tanksByStation.get(station.getId());
                List<Pump> pumps = pumpsByStation.get(station.getId());
                Map<UUID, List<Nozzle>> nozzles = nozzlesByPump.get(station.getId());

                // Tank readings at 6AM
                totalEvents += generateTankReadings(tenant, station, tanks, products, dayStart, 6, false);

                // Transactions throughout the day (50-120 per station)
                int txCount = 60 + random.nextInt(60);
                // Station 2 (index 1) has data gap on day 4 (dayOffset=3) - simulate missing
                // telemetry
                boolean isDataGapScenario = si == 1 && dayOffset == 3;
                if (!isDataGapScenario) {
                    totalEvents += generateTransactions(tenant, station, pumps, nozzles, products, dayStart, txCount);
                    // Tank readings at 6PM
                    totalEvents += generateTankReadings(tenant, station, tanks, products, dayStart, 18, true);
                }

                // Payments
                // Station 0: introduce POS delay scenario on day 5
                boolean isPosDelayScenario = si == 0 && dayOffset == 4;
                // Station 2: introduce cash leakage scenario (underpay)
                boolean isCashLeakageScenario = si == 2 && dayOffset == 2;
                totalEvents += generatePayments(tenant, station, pumps, nozzles, products, dayStart, txCount,
                        isPosDelayScenario, isCashLeakageScenario);
            }
        }

        // Run reconciliation for all days
        for (Station station : stations) {
            for (int i = 6; i >= 0; i--) {
                try {
                    LocalDate day = LocalDate.now(ZoneOffset.UTC).minusDays(i);
                    Instant dayStart = day.atStartOfDay().toInstant(ZoneOffset.UTC);
                    Instant dayEnd = dayStart.plus(1, ChronoUnit.DAYS);
                    var result = reconciliationEngine.compute(tenant.getId(), station.getId(), dayStart, dayEnd, "DAY");
                    alertEngine.generateVarianceAlert(result);
                } catch (Exception e) {
                    log.warn("Reconciliation failed for station {}: {}", station.getId(), e.getMessage());
                }
            }
            // Compute twin snapshot
            twinStateService.computeAndSave(tenant.getId(), station.getId());
        }

        // Check data gaps (station 1 had a gap day)
        alertEngine.checkDataGaps(tenant.getId());

        log.info("Seed data generation complete. Total events: {}", totalEvents);
        return Map.of(
                "status", "seeded",
                "tenantId", tenant.getId().toString(),
                "stationCount", stations.size(),
                "totalEvents", totalEvents);
    }

    private Tenant createTenant() {
        Tenant tenant = new Tenant();
        tenant.setName("Demo Fuel Retail Group");
        tenant.setSlug("demo-tenant");
        tenant.setConfig(Map.of("currency", "NGN", "country", "Nigeria"));
        return tenantRepository.save(tenant);
    }

    private List<Product> createProducts(Tenant tenant) {
        List<Map<String, Object>> specs = List.of(
                Map.of("code", "PMS", "name", "Premium Motor Spirit", "price", 617.0),
                Map.of("code", "AGO", "name", "Automotive Gas Oil", "price", 1200.0),
                Map.of("code", "DPK", "name", "Dual Purpose Kerosene", "price", 750.0));
        List<Product> products = new ArrayList<>();
        for (var spec : specs) {
            Product p = new Product();
            p.setTenantId(tenant.getId());
            p.setCode((String) spec.get("code"));
            p.setName((String) spec.get("name"));
            p.setUnitPrice(BigDecimal.valueOf(((Number) spec.get("price")).doubleValue()));
            products.add(productRepository.save(p));
        }
        return products;
    }

    private List<Station> createStations(Tenant tenant, int count) {
        String[] names = { "Lekki Phase 1", "Victoria Island", "Ikeja Central" };
        String[] locations = { "Lekki-Epe Expressway, Lagos", "Adeola Odeku Street, VI, Lagos",
                "Obafemi Awolowo Way, Ikeja, Lagos" };
        List<Station> stations = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            Station s = new Station();
            s.setTenantId(tenant.getId());
            s.setName(names[i]);
            s.setLocation(locations[i]);
            stations.add(stationRepository.save(s));
        }
        return stations;
    }

    private List<Tank> createTanks(Tenant tenant, Station station, List<Product> products) {
        List<Tank> tanks = new ArrayList<>();
        // 2 tanks per station: PMS + AGO
        for (int i = 0; i < 2; i++) {
            Tank t = new Tank();
            t.setTenantId(tenant.getId());
            t.setStationId(station.getId());
            t.setProductId(products.get(i).getId()); // PMS, AGO
            t.setLabel("Tank " + (i + 1) + " (" + products.get(i).getCode() + ")");
            t.setCapacityLiters(BigDecimal.valueOf(i == 0 ? 33000 : 22000));
            tanks.add(tankRepository.save(t));
        }
        return tanks;
    }

    private List<Pump> createPumps(Tenant tenant, Station station, int count) {
        List<Pump> pumps = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            Pump p = new Pump();
            p.setTenantId(tenant.getId());
            p.setStationId(station.getId());
            p.setLabel("Pump " + (i + 1));
            pumps.add(pumpRepository.save(p));
        }
        return pumps;
    }

    private List<Nozzle> createNozzles(Tenant tenant, Station station, Pump pump, List<Product> products) {
        List<Nozzle> nozzles = new ArrayList<>();
        // 2 nozzles per pump
        for (int i = 0; i < 2; i++) {
            Nozzle n = new Nozzle();
            n.setTenantId(tenant.getId());
            n.setStationId(station.getId());
            n.setPumpId(pump.getId());
            n.setProductId(products.get(i % 2).getId()); // PMS or AGO
            n.setLabel(pump.getLabel() + " N" + (i + 1));
            nozzles.add(nozzleRepository.save(n));
        }
        return nozzles;
    }

    private void createUsers(Tenant tenant, List<Station> stations) {
        createUser(tenant, "admin", "admin@demo.com", "admin123", List.of("OWNER"));
        createUser(tenant, "finance", "finance@demo.com", "finance123", List.of("FINANCE"));
        createUser(tenant, "ops", "ops@demo.com", "ops123", List.of("OPS"));
        createUser(tenant, "manager1", "manager1@demo.com", "manager123", List.of("STATION_MANAGER"));
    }

    private void createUser(Tenant tenant, String username, String email, String password, List<String> roles) {
        AppUser user = new AppUser();
        user.setTenantId(tenant.getId());
        user.setUsername(username);
        user.setEmail(email);
        user.setPasswordHash(passwordEncoder.encode(password));
        user.setRoles(new ArrayList<>(roles));
        userRepository.save(user);
    }

    private int generateTankReadings(Tenant tenant, Station station, List<Tank> tanks,
            List<Product> products, Instant dayStart, int hour, boolean isEvening) {
        int count = 0;
        for (Tank tank : tanks) {
            double baseLevel = isEvening ? 12000 + random.nextInt(5000) : 18000 + random.nextInt(8000);
            Instant readingTime = dayStart.plus(hour, ChronoUnit.HOURS)
                    .plus(random.nextInt(30), ChronoUnit.MINUTES);

            RawEvent raw = buildRawEvent(tenant.getId(), station.getId(), "pts2", "TANK_READING",
                    Map.of(
                            "tankId", tank.getId().toString(),
                            "level", baseLevel,
                            "reportedLiters", baseLevel,
                            "dipType", "VOLUME",
                            "unit", "liters"),
                    readingTime);
            ingestionService.ingest(raw);
            count++;
        }
        return count;
    }

    private int generateTransactions(Tenant tenant, Station station, List<Pump> pumps,
            Map<UUID, List<Nozzle>> nozzlesByPump, List<Product> products, Instant dayStart, int txCount) {
        double[] prices = { 617.0, 1200.0 }; // PMS, AGO
        int count = 0;
        for (int t = 0; t < txCount; t++) {
            Pump pump = pumps.get(random.nextInt(pumps.size()));
            List<Nozzle> nozzles = nozzlesByPump.get(pump.getId());
            if (nozzles == null || nozzles.isEmpty())
                continue;
            Nozzle nozzle = nozzles.get(random.nextInt(nozzles.size()));

            // Find product price
            double unitPrice = 617.0;
            for (Product p : products) {
                if (p.getId().equals(nozzle.getProductId())) {
                    unitPrice = p.getUnitPrice().doubleValue();
                }
            }

            double liters = 10 + random.nextDouble() * 50;
            double totalAmount = liters * unitPrice;

            // Spread transactions throughout the day
            long minuteOffset = (long) (t * (16.0 * 60 / txCount)) + random.nextInt(5);
            Instant txTime = dayStart.plus(6, ChronoUnit.HOURS).plus(minuteOffset, ChronoUnit.MINUTES);

            RawEvent raw = buildRawEvent(tenant.getId(), station.getId(), "pts2", "FUEL_DISPENSE",
                    Map.of(
                            "nozzleId", nozzle.getId().toString(),
                            "pumpId", pump.getId().toString(),
                            "liters", round(liters, 2),
                            "unitPrice", unitPrice,
                            "totalAmount", round(totalAmount, 2),
                            "shiftId", "SHIFT_AM"),
                    txTime);
            ingestionService.ingest(raw);
            count++;
        }
        return count;
    }

    private int generatePayments(Tenant tenant, Station station, List<Pump> pumps,
            Map<UUID, List<Nozzle>> nozzlesByPump, List<Product> products,
            Instant dayStart, int txCount, boolean isPosDelay, boolean isCashLeakage) {
        // Calculate approximate expected revenue
        double avgLiters = 30.0;
        double avgPrice = 617.0;
        double expectedTotal = txCount * avgLiters * avgPrice;

        double cashShare = isCashLeakage ? 0.25 : 0.50;
        double posShare = isPosDelay ? 0.0 : 0.35; // POS delay: no POS payments received today
        double transferShare = isPosDelay ? 0.15 : 0.15;

        // For cash leakage: under-pay by 15%
        double leakageFactor = isCashLeakage ? 0.85 : 1.0;

        double cashAmount = expectedTotal * cashShare * leakageFactor;
        double posAmount = expectedTotal * posShare;
        double transferAmount = expectedTotal * transferShare;

        int count = 0;
        Instant endOfDay = dayStart.plus(22, ChronoUnit.HOURS);

        if (cashAmount > 0)
            count += savePayment(tenant.getId(), station.getId(), "CASH", cashAmount, dayStart, endOfDay);
        if (posAmount > 0)
            count += savePayment(tenant.getId(), station.getId(), "POS", posAmount, dayStart, endOfDay);
        if (transferAmount > 0)
            count += savePayment(tenant.getId(), station.getId(), "TRANSFER", transferAmount, dayStart, endOfDay);

        return count;
    }

    private int savePayment(UUID tenantId, UUID stationId, String type, double amount, Instant from, Instant to) {
        PaymentEvent p = new PaymentEvent();
        p.setTenantId(tenantId);
        p.setStationId(stationId);
        p.setPaymentType(type);
        p.setAmount(BigDecimal.valueOf(amount).setScale(2, RoundingMode.HALF_UP));
        p.setCurrency("NGN");
        p.setShiftId("SHIFT_AM");
        p.setReference("REF-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase());
        // Random time in range
        long secs = from.getEpochSecond();
        long endSecs = to.getEpochSecond();
        p.setEventTime(Instant.ofEpochSecond(secs + (long) (random.nextDouble() * (endSecs - secs))));
        paymentEventRepository.save(p);
        return 1;
    }

    private RawEvent buildRawEvent(UUID tenantId, UUID stationId, String source, String type,
            Map<String, Object> payload, Instant deviceTime) {
        RawEvent raw = new RawEvent();
        raw.setTenantId(tenantId);
        raw.setStationId(stationId);
        raw.setSource(source);
        raw.setEventId(UUID.randomUUID().toString());
        raw.setEventType(type);
        raw.setPayload(new HashMap<>(payload));
        raw.setDeviceTime(deviceTime);
        raw.setReceivedTime(deviceTime.plusSeconds(random.nextInt(5)));
        return raw;
    }

    private double round(double val, int scale) {
        return BigDecimal.valueOf(val).setScale(scale, RoundingMode.HALF_UP).doubleValue();
    }
}
