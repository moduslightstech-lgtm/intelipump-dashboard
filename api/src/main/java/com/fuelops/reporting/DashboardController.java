package com.fuelops.reporting;

import com.fuelops.alerts.AlertRepository;
import com.fuelops.normalization.CanonicalEventRepository;
import com.fuelops.normalization.PaymentEventRepository;
import com.fuelops.reconciliation.ReconciliationResultRepository;
import com.fuelops.tenancy.StationRepository;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/dashboard")
@RequiredArgsConstructor
@Tag(name = "Dashboard", description = "Executive overview dashboard endpoints")
public class DashboardController {

    private final StationRepository stationRepository;
    private final CanonicalEventRepository canonicalEventRepository;
    private final PaymentEventRepository paymentEventRepository;
    private final ReconciliationResultRepository reconciliationResultRepository;
    private final AlertRepository alertRepository;

    @GetMapping("/overview")
    @Operation(summary = "Executive overview: total liters, revenue, variance, station coverage")
    public ResponseEntity<?> overview(@RequestHeader("X-Tenant-Id") UUID tenantId) {
        Instant todayStart = LocalDate.now(ZoneOffset.UTC).atStartOfDay().toInstant(ZoneOffset.UTC);
        Instant now = Instant.now();
        Instant sevenDaysAgo = now.minus(7, ChronoUnit.DAYS);

        var stations = stationRepository.findByTenantId(tenantId);
        int totalStations = stations.size();

        // Stations reporting today
        long reportingToday = stations.stream()
                .filter(s -> canonicalEventRepository.findLatestEventTimeByStationAndType(s.getId(), "FUEL_DISPENSE")
                        .map(t -> t.isAfter(todayStart)).orElse(false))
                .count();

        // Total liters and revenue across all stations today
        BigDecimal totalLiters = BigDecimal.ZERO;
        BigDecimal totalRevenue = BigDecimal.ZERO;
        for (var station : stations) {
            totalLiters = totalLiters
                    .add(canonicalEventRepository.sumPumpLitersForStation(station.getId(), todayStart, now));
            totalRevenue = totalRevenue
                    .add(canonicalEventRepository.sumExpectedRevenueForStation(station.getId(), todayStart, now));
        }

        // Total variance (7 days)
        var recentRecons = reconciliationResultRepository
                .findByTenantIdAndWindowFromBetweenOrderByWindowFromDesc(tenantId, sevenDaysAgo, now);
        BigDecimal totalVariance = recentRecons.stream()
                .map(r -> r.getVariance())
                .reduce(BigDecimal.ZERO, BigDecimal::add);

        // Top stations by variance
        var topVariance = recentRecons.stream()
                .collect(Collectors.groupingBy(r -> r.getStationId().toString(),
                        Collectors.reducing(BigDecimal.ZERO, r -> r.getVariance().abs(), BigDecimal::add)))
                .entrySet().stream()
                .sorted(Map.Entry.<String, BigDecimal>comparingByValue().reversed())
                .limit(5)
                .map(e -> Map.of("stationId", e.getKey(), "totalVariance", e.getValue()))
                .collect(Collectors.toList());

        // Revenue trend last 7 days
        List<Map<String, Object>> revenueTrend = new ArrayList<>();
        for (int i = 6; i >= 0; i--) {
            LocalDate day = LocalDate.now(ZoneOffset.UTC).minusDays(i);
            Instant dayStart = day.atStartOfDay().toInstant(ZoneOffset.UTC);
            Instant dayEnd = dayStart.plus(1, ChronoUnit.DAYS);
            BigDecimal dayRevenue = BigDecimal.ZERO;
            for (var station : stations) {
                dayRevenue = dayRevenue
                        .add(canonicalEventRepository.sumExpectedRevenueForStation(station.getId(), dayStart, dayEnd));
            }
            revenueTrend.add(Map.of("date", day.toString(), "revenue", dayRevenue.setScale(2, RoundingMode.HALF_UP)));
        }

        // Open alerts count
        long openAlerts = alertRepository.findByTenantIdOrderByTriggeredAtDesc(tenantId)
                .stream().filter(a -> "OPEN".equals(a.getStatus())).count();

        return ResponseEntity.ok(Map.of(
                "totalStations", totalStations,
                "stationsReportingToday", reportingToday,
                "totalLitersToday", totalLiters.setScale(2, RoundingMode.HALF_UP),
                "totalRevenueToday", totalRevenue.setScale(2, RoundingMode.HALF_UP),
                "totalVariance7Days", totalVariance.setScale(2, RoundingMode.HALF_UP),
                "topStationsByVariance", topVariance,
                "revenueTrend7Days", revenueTrend,
                "openAlerts", openAlerts));
    }
}
