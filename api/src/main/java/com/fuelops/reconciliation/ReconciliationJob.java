package com.fuelops.reconciliation;

import com.fuelops.alerts.AlertEngine;
import com.fuelops.tenancy.StationRepository;
import com.fuelops.tenancy.TenantRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;

@Component
@RequiredArgsConstructor
@Slf4j
public class ReconciliationJob {

    private final TenantRepository tenantRepository;
    private final StationRepository stationRepository;
    private final ReconciliationEngine reconciliationEngine;
    private final AlertEngine alertEngine;

    // Run daily at 1 AM UTC
    @Scheduled(cron = "0 0 1 * * *")
    public void runDailyReconciliation() {
        log.info("Running scheduled daily reconciliation...");
        Instant yesterday = LocalDate.now(ZoneOffset.UTC).minusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC);
        Instant endOfYesterday = yesterday.plus(1, ChronoUnit.DAYS);

        tenantRepository.findAll().forEach(tenant -> {
            stationRepository.findByTenantId(tenant.getId()).forEach(station -> {
                try {
                    var result = reconciliationEngine.compute(
                            tenant.getId(), station.getId(), yesterday, endOfYesterday, "DAY");
                    alertEngine.generateVarianceAlert(result);
                } catch (Exception e) {
                    log.error("Reconciliation failed for station {}: {}", station.getId(), e.getMessage());
                }
            });
            alertEngine.checkDataGaps(tenant.getId());
        });
    }

    // Also run every hour for near-real-time checks
    @Scheduled(cron = "0 0 * * * *")
    public void runHourlyDataGapCheck() {
        tenantRepository.findAll().forEach(tenant -> alertEngine.checkDataGaps(tenant.getId()));
    }
}
