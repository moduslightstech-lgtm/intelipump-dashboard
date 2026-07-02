package com.fuelops.reconciliation;

import com.fuelops.normalization.AdjustmentEventRepository;
import com.fuelops.normalization.CanonicalEventRepository;
import com.fuelops.normalization.PaymentEventRepository;
import com.fuelops.tenancy.TankRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Slf4j
public class ReconciliationEngine {

    private final CanonicalEventRepository canonicalEventRepository;
    private final PaymentEventRepository paymentEventRepository;
    private final AdjustmentEventRepository adjustmentEventRepository;
    private final ReconciliationResultRepository reconciliationResultRepository;

    @Value("${fuelops.reconciliation.thresholds.warn-percent:5.0}")
    private double warnThresholdPercent;

    @Value("${fuelops.reconciliation.thresholds.critical-percent:10.0}")
    private double criticalThresholdPercent;

    @Transactional
    public ReconciliationResult compute(UUID tenantId, UUID stationId, Instant from, Instant to, String granularity) {
        log.info("Computing reconciliation: station={} from={} to={}", stationId, from, to);

        // Expected revenue from dispense transactions
        BigDecimal expectedRevenue = canonicalEventRepository.sumExpectedRevenueForStation(stationId, from, to);

        // Pump total liters dispensed
        BigDecimal pumpLiters = canonicalEventRepository.sumPumpLitersForStation(stationId, from, to);

        // Received payments by type
        BigDecimal receivedCash = paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "CASH", from,
                to);
        BigDecimal receivedPos = paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "POS", from, to);
        BigDecimal receivedTransfer = paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "TRANSFER",
                from, to);
        BigDecimal totalReceived = receivedCash.add(receivedPos).add(receivedTransfer);

        // Manual adjustments
        BigDecimal adjustments = adjustmentEventRepository.sumAdjustmentsForStation(stationId, from, to);
        BigDecimal adjustedReceived = totalReceived.add(adjustments);

        // Variance = received - expected (positive = surplus, negative = deficit)
        BigDecimal variance = adjustedReceived.subtract(expectedRevenue);

        // Variance percent
        BigDecimal variancePercent = BigDecimal.ZERO;
        if (expectedRevenue.compareTo(BigDecimal.ZERO) != 0) {
            variancePercent = variance.divide(expectedRevenue, 6, RoundingMode.HALF_UP)
                    .multiply(BigDecimal.valueOf(100));
        }

        // Determine status
        String status = determineStatus(variancePercent.abs().doubleValue());

        // Upsert result
        Optional<ReconciliationResult> existing = reconciliationResultRepository
                .findByStationIdAndWindowFromAndWindowToAndGranularity(stationId, from, to, granularity);

        ReconciliationResult result = existing.orElse(new ReconciliationResult());
        result.setTenantId(tenantId);
        result.setStationId(stationId);
        result.setWindowFrom(from);
        result.setWindowTo(to);
        result.setGranularity(granularity);
        result.setExpectedRevenue(expectedRevenue.setScale(2, RoundingMode.HALF_UP));
        result.setReceivedCash(receivedCash.setScale(2, RoundingMode.HALF_UP));
        result.setReceivedPos(receivedPos.setScale(2, RoundingMode.HALF_UP));
        result.setReceivedTransfer(receivedTransfer.setScale(2, RoundingMode.HALF_UP));
        result.setTotalReceived(adjustedReceived.setScale(2, RoundingMode.HALF_UP));
        result.setVariance(variance.setScale(2, RoundingMode.HALF_UP));
        result.setVariancePercent(variancePercent.setScale(4, RoundingMode.HALF_UP));
        result.setPumpLiters(pumpLiters.setScale(4, RoundingMode.HALF_UP));
        result.setStatus(status);
        result.setComputedAt(Instant.now());

        return reconciliationResultRepository.save(result);
    }

    private String determineStatus(double absVariancePercent) {
        if (absVariancePercent >= criticalThresholdPercent)
            return "CRITICAL";
        if (absVariancePercent >= warnThresholdPercent)
            return "WARN";
        return "OK";
    }
}
