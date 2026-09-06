package com.fuelops.reporting;

import com.fuelops.alerts.AlertRepository;
import com.fuelops.normalization.AdjustmentEvent;
import com.fuelops.normalization.AdjustmentEventRepository;
import com.fuelops.normalization.CanonicalEventRepository;
import com.fuelops.normalization.PaymentEventRepository;
import com.fuelops.reconciliation.ReconciliationEngine;
import com.fuelops.reconciliation.ReconciliationResultRepository;
import com.fuelops.tenancy.*;
import com.fuelops.twin.TwinStateService;
import com.fuelops.twin.StationStateSnapshotRepository;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.*;

@RestController
@RequestMapping("/api/stations")
@RequiredArgsConstructor
@Tag(name = "Stations", description = "Station management and digital twin endpoints")
public class StationController {

    private final StationRepository stationRepository;
    private final TankRepository tankRepository;
    private final PumpRepository pumpRepository;
    private final NozzleRepository nozzleRepository;
    private final TwinStateService twinStateService;
    private final StationStateSnapshotRepository snapshotRepository;
    private final ReconciliationEngine reconciliationEngine;
    private final ReconciliationResultRepository reconciliationResultRepository;
    private final AdjustmentEventRepository adjustmentEventRepository;
    private final CanonicalEventRepository canonicalEventRepository;
    private final PaymentEventRepository paymentEventRepository;
    private final PumpTransactionRepository pumpTransactionRepository;
    private final AlertRepository alertRepository;

    @GetMapping
    @Operation(summary = "List all stations for tenant")
    public ResponseEntity<?> listStations(@RequestHeader("X-Tenant-Id") UUID tenantId) {
        var stations = stationRepository.findByTenantId(tenantId);
        List<Map<String, Object>> result = new ArrayList<>();

        Instant todayStart = java.time.ZonedDateTime.now(java.time.ZoneId.of("Africa/Lagos"))
                .truncatedTo(java.time.temporal.ChronoUnit.DAYS)
                .toInstant();

        Instant pumpThreshold = Instant.now().minusSeconds(300); // 5 minutes

        for (var station : stations) {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("id", station.getId()); // Internal UUID
            s.put("stationId", station.getExternalId() != null ? station.getExternalId() : station.getId().toString());
            s.put("name", station.getName());

            boolean isOnline = station.getLastSeenAt() != null && station.getLastSeenAt().isAfter(pumpThreshold);
            s.put("status", isOnline ? "ONLINE" : "OFFLINE");
            s.put("lastSeenAt", station.getLastSeenAt() != null ? station.getLastSeenAt().toString() : null);

            var pumps = pumpRepository.findByStationId(station.getId());
            s.put("pumpCount", pumps.size());

            long onlinePumps = pumps.stream()
                    .filter(p -> p.getLastSeenAt() != null && p.getLastSeenAt().isAfter(pumpThreshold))
                    .count();
            s.put("onlinePumpCount", (int) onlinePumps);

            s.put("todayTransactionCount", pumpTransactionRepository.countByStationIdAndDeviceTimestampAfter(station.getId(), todayStart));

            BigDecimal todayVol = pumpTransactionRepository.sumVolumeByStationIdAndDeviceTimestampAfter(station.getId(), todayStart);
            s.put("todayVolumeLiters", todayVol.setScale(2, RoundingMode.HALF_UP).doubleValue());

            BigDecimal todayRev = pumpTransactionRepository.sumAmountByStationIdAndDeviceTimestampAfter(station.getId(), todayStart);
            s.put("todayRevenue", todayRev.setScale(2, RoundingMode.HALF_UP).doubleValue());

            result.add(s);
        }
        return ResponseEntity.ok(result);
    }

    @GetMapping("/{stationId}/overview")
    @Operation(summary = "Get overview metrics for a station")
    public ResponseEntity<?> getOverview(@PathVariable UUID stationId) {
        Station station = stationRepository.findById(stationId).orElseThrow();

        Instant todayStart = java.time.ZonedDateTime.now(java.time.ZoneId.of("Africa/Lagos"))
                .truncatedTo(java.time.temporal.ChronoUnit.DAYS)
                .toInstant();
        Instant threshold = Instant.now().minusSeconds(300); // 5 minutes

        boolean isOnline = station.getLastSeenAt() != null && station.getLastSeenAt().isAfter(threshold);
        var pumps = pumpRepository.findByStationId(stationId);
        long pumpsOnline = pumps.stream()
                .filter(p -> p.getLastSeenAt() != null && p.getLastSeenAt().isAfter(threshold))
                .count();
        long pumpsOffline = pumps.size() - pumpsOnline;

        long txCount = pumpTransactionRepository.countByStationIdAndDeviceTimestampAfter(stationId, todayStart);
        BigDecimal volume = pumpTransactionRepository.sumVolumeByStationIdAndDeviceTimestampAfter(stationId, todayStart);
        BigDecimal revenue = pumpTransactionRepository.sumAmountByStationIdAndDeviceTimestampAfter(stationId, todayStart);

        double avgSale = txCount > 0 ? revenue.divide(BigDecimal.valueOf(txCount), 2, RoundingMode.HALF_UP).doubleValue() : 0.0;
        double avgVol = txCount > 0 ? volume.divide(BigDecimal.valueOf(txCount), 2, RoundingMode.HALF_UP).doubleValue() : 0.0;

        long activeAlerts = alertRepository.findByStationIdOrderByTriggeredAtDesc(stationId).stream()
                .filter(a -> "OPEN".equals(a.getStatus()))
                .count();

        List<PumpTransaction> recentTx = pumpTransactionRepository.findTop10ByStationIdOrderByDeviceTimestampDesc(stationId);

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("stationId", station.getExternalId() != null ? station.getExternalId() : station.getId().toString());
        response.put("id", station.getId().toString());
        response.put("name", station.getName());
        response.put("location", station.getLocation());
        response.put("timezone", station.getTimezone());
        response.put("status", isOnline ? "ONLINE" : "OFFLINE");
        response.put("lastSeenAt", station.getLastSeenAt() != null ? station.getLastSeenAt().toString() : null);
        response.put("todayTransactionCount", txCount);
        response.put("todayVolumeLiters", volume.setScale(2, RoundingMode.HALF_UP).doubleValue());
        response.put("todayRevenue", revenue.setScale(2, RoundingMode.HALF_UP).doubleValue());
        response.put("averageTransactionAmount", avgSale);
        response.put("averageLitersPerTransaction", avgVol);
        response.put("pumpsOnline", (int) pumpsOnline);
        response.put("pumpsOffline", (int) pumpsOffline);
        response.put("activeAlertsCount", (int) activeAlerts);
        response.put("recentTransactions", recentTx);

        return ResponseEntity.ok(response);
    }

    @GetMapping("/{stationId}/pumps")
    @Operation(summary = "Get pumps list for a station")
    public ResponseEntity<?> getPumps(@PathVariable UUID stationId) {
        var pumps = pumpRepository.findByStationId(stationId);
        List<Map<String, Object>> result = new ArrayList<>();

        Instant todayStart = java.time.ZonedDateTime.now(java.time.ZoneId.of("Africa/Lagos"))
                .truncatedTo(java.time.temporal.ChronoUnit.DAYS)
                .toInstant();
        Instant threshold = Instant.now().minusSeconds(300); // 5 minutes

        for (var pump : pumps) {
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("id", pump.getId().toString());
            p.put("pumpId", pump.getExternalId() != null ? pump.getExternalId() : pump.getId().toString());
            p.put("label", pump.getLabel());

            boolean isOnline = pump.getLastSeenAt() != null && pump.getLastSeenAt().isAfter(threshold);
            String status = "OFFLINE";
            if (isOnline) {
                status = pump.getStatus() != null ? pump.getStatus() : "IDLE";
            }
            p.put("status", status);
            p.put("lastSeenAt", pump.getLastSeenAt() != null ? pump.getLastSeenAt().toString() : null);

            long txCount = pumpTransactionRepository.countByPumpIdAndDeviceTimestampAfter(pump.getId(), todayStart);
            BigDecimal vol = pumpTransactionRepository.sumVolumeByPumpIdAndDeviceTimestampAfter(pump.getId(), todayStart);
            BigDecimal rev = pumpTransactionRepository.sumAmountByPumpIdAndDeviceTimestampAfter(pump.getId(), todayStart);

            p.put("todayTransactionCount", txCount);
            p.put("todayVolumeLiters", vol.setScale(2, RoundingMode.HALF_UP).doubleValue());
            p.put("todayRevenue", rev.setScale(2, RoundingMode.HALF_UP).doubleValue());

            List<PumpTransaction> txList = pumpTransactionRepository.findTop10ByStationIdOrderByDeviceTimestampDesc(stationId);
            PumpTransaction lastTx = txList.stream()
                    .filter(t -> t.getPumpId().equals(pump.getId()))
                    .findFirst()
                    .orElse(null);

            if (lastTx != null) {
                Map<String, Object> lt = new LinkedHashMap<>();
                lt.put("transactionId", lastTx.getId());
                lt.put("volumeLiters", lastTx.getVolumeLiters().doubleValue());
                lt.put("amount", lastTx.getAmount().doubleValue());
                lt.put("product", lastTx.getProduct());
                lt.put("timestamp", lastTx.getDeviceTimestamp().toString());
                p.put("lastTransaction", lt);
            } else {
                p.put("lastTransaction", null);
            }

            result.add(p);
        }
        return ResponseEntity.ok(result);
    }

    @GetMapping("/{stationId}/twin")
    @Operation(summary = "Get digital twin state for a station")
    public ResponseEntity<?> getTwin(
            @RequestHeader("X-Tenant-Id") UUID tenantId,
            @PathVariable UUID stationId) {
        // Refresh and return snapshot
        var snapshot = twinStateService.computeAndSave(tenantId, stationId);
        var station = stationRepository.findById(stationId).orElseThrow();

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("stationId", stationId);
        response.put("stationName", station.getName());
        response.put("snapshotTime", snapshot.getSnapshotTime());
        response.put("tankStates", snapshot.getTankStates());
        response.put("pumpStates", snapshot.getPumpStates());
        response.put("lastEventTimes", snapshot.getLastEventTimes());

        return ResponseEntity.ok(response);
    }

    @GetMapping("/{stationId}/reconciliation")
    @Operation(summary = "Get reconciliation results for a station with optional date range")
    public ResponseEntity<?> getReconciliation(
            @RequestHeader("X-Tenant-Id") UUID tenantId,
            @PathVariable UUID stationId,
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to) {

        Instant fromInstant = from != null ? Instant.parse(from)
                : Instant.now().minus(java.time.temporal.ChronoUnit.DAYS.getDuration().multipliedBy(7));
        Instant toInstant = to != null ? Instant.parse(to) : Instant.now();

        var results = reconciliationResultRepository.findByStationIdAndWindowFromBetweenOrderByWindowFromAsc(
                stationId, fromInstant, toInstant);

        // Also return evidence: recent transactions and payments
        var transactions = canonicalEventRepository.findByStationIdAndEventTypeAndEventTimeBetweenOrderByEventTimeAsc(
                stationId, "FUEL_DISPENSE", fromInstant, toInstant);
        var payments = paymentEventRepository.findByStationIdAndEventTimeBetween(stationId, fromInstant, toInstant);

        return ResponseEntity.ok(Map.of(
                "stationId", stationId,
                "from", fromInstant,
                "to", toInstant,
                "results", results,
                "transactionCount", transactions.size(),
                "transactions", transactions.stream().limit(100).toList(),
                "paymentCount", payments.size(),
                "payments", payments.stream().limit(100).toList()));
    }

    @PostMapping("/{stationId}/adjustments")
    @Operation(summary = "Create a manual adjustment event")
    public ResponseEntity<?> createAdjustment(
            @RequestHeader("X-Tenant-Id") UUID tenantId,
            @PathVariable UUID stationId,
            @RequestBody AdjustmentRequest request) {

        AdjustmentEvent adj = new AdjustmentEvent();
        adj.setTenantId(tenantId);
        adj.setStationId(stationId);
        adj.setReason(request.reason());
        adj.setWindowFrom(Instant.parse(request.windowFrom()));
        adj.setWindowTo(Instant.parse(request.windowTo()));
        if (request.amountAdjustment() != null)
            adj.setAmountAdjustment(new java.math.BigDecimal(request.amountAdjustment().toString()));
        if (request.litersAdjustment() != null)
            adj.setLitersAdjustment(new java.math.BigDecimal(request.litersAdjustment().toString()));
        if (request.attachmentMeta() != null)
            adj.setAttachmentMeta(request.attachmentMeta());

        var saved = adjustmentEventRepository.save(adj);

        // Re-run reconciliation after adjustment
        try {
            reconciliationEngine.compute(tenantId, stationId,
                    adj.getWindowFrom(), adj.getWindowTo(), "DAY");
        } catch (Exception e) {
            // Non-blocking; adjustment saved
        }

        return ResponseEntity.ok(saved);
    }

    @PostMapping("/reconciliation/run-all")
    @Operation(summary = "Manually trigger reconciliation for all stations (last 7 days)")
    public ResponseEntity<?> runAllReconciliation(@RequestHeader("X-Tenant-Id") UUID tenantId) {
        var stations = stationRepository.findByTenantId(tenantId);
        int computed = 0;
        for (var station : stations) {
            for (int i = 0; i < 7; i++) {
                Instant dayStart = java.time.LocalDate.now(java.time.ZoneOffset.UTC)
                        .minusDays(i).atStartOfDay().toInstant(java.time.ZoneOffset.UTC);
                Instant dayEnd = dayStart.plus(1, java.time.temporal.ChronoUnit.DAYS);
                try {
                    reconciliationEngine.compute(tenantId, station.getId(), dayStart, dayEnd, "DAY");
                    computed++;
                } catch (Exception e) {
                    /* continue */ }
            }
        }
        return ResponseEntity.ok(Map.of("computed", computed, "stations", stations.size()));
    }

    record AdjustmentRequest(String reason, String windowFrom, String windowTo,
            Number amountAdjustment, Number litersAdjustment,
            Map<String, Object> attachmentMeta) {
    }
}
