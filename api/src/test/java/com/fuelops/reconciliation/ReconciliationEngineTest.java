package com.fuelops.reconciliation;

import com.fuelops.normalization.AdjustmentEventRepository;
import com.fuelops.normalization.CanonicalEventRepository;
import com.fuelops.normalization.PaymentEventRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ReconciliationEngineTest {

    @Mock
    private CanonicalEventRepository canonicalEventRepository;
    @Mock
    private PaymentEventRepository paymentEventRepository;
    @Mock
    private AdjustmentEventRepository adjustmentEventRepository;
    @Mock
    private ReconciliationResultRepository reconciliationResultRepository;

    private ReconciliationEngine engine;

    private final UUID tenantId = UUID.randomUUID();
    private final UUID stationId = UUID.randomUUID();
    private final Instant from = Instant.parse("2025-03-01T00:00:00Z");
    private final Instant to = Instant.parse("2025-03-02T00:00:00Z");

    @BeforeEach
    void setUp() {
        engine = new ReconciliationEngine(
                canonicalEventRepository,
                paymentEventRepository,
                adjustmentEventRepository,
                reconciliationResultRepository);
        ReflectionTestUtils.setField(engine, "warnThresholdPercent", 5.0);
        ReflectionTestUtils.setField(engine, "criticalThresholdPercent", 10.0);

        when(reconciliationResultRepository.findByStationIdAndWindowFromAndWindowToAndGranularity(
                any(), any(), any(), any())).thenReturn(Optional.empty());
        when(reconciliationResultRepository.save(any())).thenAnswer(i -> i.getArgument(0));
    }

    @Test
    void testOkStatus_whenVarianceBelowWarnThreshold() {
        // Expected: 100,000 NGN
        when(canonicalEventRepository.sumExpectedRevenueForStation(stationId, from, to))
                .thenReturn(new BigDecimal("100000.00"));
        when(canonicalEventRepository.sumPumpLitersForStation(stationId, from, to))
                .thenReturn(new BigDecimal("150.00"));

        // Received: 98,000 NGN (2% deficit → OK)
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "CASH", from, to))
                .thenReturn(new BigDecimal("50000.00"));
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "POS", from, to))
                .thenReturn(new BigDecimal("48000.00"));
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "TRANSFER", from, to))
                .thenReturn(BigDecimal.ZERO);
        when(adjustmentEventRepository.sumAdjustmentsForStation(stationId, from, to))
                .thenReturn(BigDecimal.ZERO);

        ReconciliationResult result = engine.compute(tenantId, stationId, from, to, "DAY");

        assertThat(result.getStatus()).isEqualTo("OK");
        assertThat(result.getVariance()).isEqualByComparingTo(new BigDecimal("-2000.00"));
        assertThat(result.getVariancePercent().abs()).isLessThan(new BigDecimal("5.0"));
    }

    @Test
    void testWarnStatus_whenVarianceIs7Percent() {
        when(canonicalEventRepository.sumExpectedRevenueForStation(stationId, from, to))
                .thenReturn(new BigDecimal("100000.00"));
        when(canonicalEventRepository.sumPumpLitersForStation(stationId, from, to))
                .thenReturn(BigDecimal.ZERO);
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "CASH", from, to))
                .thenReturn(new BigDecimal("93000.00"));
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "POS", from, to))
                .thenReturn(BigDecimal.ZERO);
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "TRANSFER", from, to))
                .thenReturn(BigDecimal.ZERO);
        when(adjustmentEventRepository.sumAdjustmentsForStation(stationId, from, to))
                .thenReturn(BigDecimal.ZERO);

        ReconciliationResult result = engine.compute(tenantId, stationId, from, to, "DAY");

        assertThat(result.getStatus()).isEqualTo("WARN");
    }

    @Test
    void testCriticalStatus_whenVarianceExceeds10Percent() {
        when(canonicalEventRepository.sumExpectedRevenueForStation(stationId, from, to))
                .thenReturn(new BigDecimal("100000.00"));
        when(canonicalEventRepository.sumPumpLitersForStation(stationId, from, to))
                .thenReturn(BigDecimal.ZERO);
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "CASH", from, to))
                .thenReturn(new BigDecimal("85000.00"));
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "POS", from, to))
                .thenReturn(BigDecimal.ZERO);
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "TRANSFER", from, to))
                .thenReturn(BigDecimal.ZERO);
        when(adjustmentEventRepository.sumAdjustmentsForStation(stationId, from, to))
                .thenReturn(BigDecimal.ZERO);

        ReconciliationResult result = engine.compute(tenantId, stationId, from, to, "DAY");

        assertThat(result.getStatus()).isEqualTo("CRITICAL");
    }

    @Test
    void testAdjustmentReducesVariance() {
        when(canonicalEventRepository.sumExpectedRevenueForStation(stationId, from, to))
                .thenReturn(new BigDecimal("100000.00"));
        when(canonicalEventRepository.sumPumpLitersForStation(stationId, from, to))
                .thenReturn(BigDecimal.ZERO);
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "CASH", from, to))
                .thenReturn(new BigDecimal("85000.00"));
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "POS", from, to))
                .thenReturn(BigDecimal.ZERO);
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(stationId, "TRANSFER", from, to))
                .thenReturn(BigDecimal.ZERO);
        // Adjustment brings it to 88,500 → 11.5% deficit still CRITICAL
        when(adjustmentEventRepository.sumAdjustmentsForStation(stationId, from, to))
                .thenReturn(new BigDecimal("3500.00"));

        ReconciliationResult result = engine.compute(tenantId, stationId, from, to, "DAY");

        // Still CRITICAL but variance improved
        assertThat(result.getTotalReceived()).isEqualByComparingTo(new BigDecimal("88500.00"));
        assertThat(result.getStatus()).isEqualTo("CRITICAL");
    }

    @Test
    void testZeroExpectedRevenueResultsInZeroVariancePercent() {
        when(canonicalEventRepository.sumExpectedRevenueForStation(stationId, from, to))
                .thenReturn(BigDecimal.ZERO);
        when(canonicalEventRepository.sumPumpLitersForStation(stationId, from, to))
                .thenReturn(BigDecimal.ZERO);
        when(paymentEventRepository.sumByStationIdAndTypeAndTimeBetween(any(), any(), any(), any()))
                .thenReturn(BigDecimal.ZERO);
        when(adjustmentEventRepository.sumAdjustmentsForStation(any(), any(), any()))
                .thenReturn(BigDecimal.ZERO);

        ReconciliationResult result = engine.compute(tenantId, stationId, from, to, "DAY");

        assertThat(result.getVariancePercent()).isEqualByComparingTo(BigDecimal.ZERO);
        assertThat(result.getStatus()).isEqualTo("OK");
    }
}
