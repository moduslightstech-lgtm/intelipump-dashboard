package com.fuelops.alerts;

import com.fuelops.ingestion.RawEventRepository;
import com.fuelops.reconciliation.ReconciliationResult;
import com.fuelops.reconciliation.ReconciliationResultRepository;
import com.fuelops.tenancy.StationRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Slf4j
public class AlertEngine {

    private final AlertRepository alertRepository;
    private final RawEventRepository rawEventRepository;
    private final StationRepository stationRepository;
    private final ReconciliationResultRepository reconciliationResultRepository;

    @Value("${fuelops.alerts.data-gap-threshold-minutes:60}")
    private long dataGapThresholdMinutes;

    @Transactional
    public void generateVarianceAlert(ReconciliationResult result) {
        if ("OK".equals(result.getStatus()))
            return;

        // Check if alert already exists for this reconciliation window
        List<Alert> existing = alertRepository.findByStationIdAndAlertTypeAndStatus(
                result.getStationId(), "VARIANCE", "OPEN");
        boolean alreadyAlerting = existing.stream()
                .anyMatch(a -> a.getDetails().containsKey("windowFrom")
                        && a.getDetails().get("windowFrom").toString().equals(result.getWindowFrom().toString()));
        if (alreadyAlerting)
            return;

        Alert alert = new Alert();
        alert.setTenantId(result.getTenantId());
        alert.setStationId(result.getStationId());
        alert.setAlertType("VARIANCE");
        alert.setSeverity(result.getStatus()); // WARN or CRITICAL
        alert.setTitle(String.format("Revenue variance %s: %.2f%% (₦%.2f)",
                result.getStatus(), result.getVariancePercent().doubleValue(),
                result.getVariance().doubleValue()));
        alert.setDetails(Map.of(
                "windowFrom", result.getWindowFrom().toString(),
                "windowTo", result.getWindowTo().toString(),
                "expectedRevenue", result.getExpectedRevenue(),
                "totalReceived", result.getTotalReceived(),
                "variance", result.getVariance(),
                "variancePercent", result.getVariancePercent(),
                "status", result.getStatus()));
        alertRepository.save(alert);
        log.info("Variance alert created: station={} status={}", result.getStationId(), result.getStatus());
    }

    @Transactional
    public void checkDataGaps(UUID tenantId) {
        List<com.fuelops.tenancy.Station> stations = stationRepository.findByTenantId(tenantId);
        Instant threshold = Instant.now().minus(dataGapThresholdMinutes, ChronoUnit.MINUTES);

        for (var station : stations) {
            var lastSeen = rawEventRepository.findLastReceivedTimeByStationId(station.getId());
            if (lastSeen.isEmpty() || lastSeen.get().isBefore(threshold)) {
                // Check if we already have an open DATA_GAP alert
                List<Alert> existing = alertRepository.findByStationIdAndAlertTypeAndStatus(
                        station.getId(), "DATA_GAP", "OPEN");
                if (!existing.isEmpty())
                    continue;

                Alert alert = new Alert();
                alert.setTenantId(tenantId);
                alert.setStationId(station.getId());
                alert.setAlertType("DATA_GAP");
                alert.setSeverity("WARN");
                alert.setTitle(String.format("No telemetry from %s for >%d minutes",
                        station.getName(), dataGapThresholdMinutes));
                alert.setDetails(Map.of(
                        "lastSeen", lastSeen.map(Instant::toString).orElse("never"),
                        "thresholdMinutes", dataGapThresholdMinutes,
                        "stationName", station.getName()));
                alertRepository.save(alert);
                log.info("Data gap alert created: station={}", station.getId());
            }
        }
    }
}
