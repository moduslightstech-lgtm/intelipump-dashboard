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

    @GetMapping
    @Operation(summary = "List all stations for tenant")
    public ResponseEntity<?> listStations(@RequestHeader("X-Tenant-Id") UUID tenantId) {
        var stations = stationRepository.findByTenantId(tenantId);
        List<Map<String, Object>> result = new ArrayList<>();
        for (var station : stations) {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("id", station.getId());
            s.put("name", station.getName());
            s.put("location", station.getLocation());
            s.put("timezone", station.getTimezone());
            s.put("active", station.isActive());
            s.put("tankCount", tankRepository.findByStationId(station.getId()).size());
            s.put("pumpCount", pumpRepository.findByStationId(station.getId()).size());
            result.add(s);
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
