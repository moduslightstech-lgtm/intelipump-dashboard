package com.fuelops.reconciliation;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "reconciliation_result", uniqueConstraints = @UniqueConstraint(columnNames = { "station_id",
        "window_from", "window_to", "granularity" }))
@Data
@NoArgsConstructor
public class ReconciliationResult {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "station_id", nullable = false)
    private UUID stationId;

    @Column(name = "window_from", nullable = false)
    private Instant windowFrom;

    @Column(name = "window_to", nullable = false)
    private Instant windowTo;

    @Column(nullable = false)
    private String granularity = "DAY"; // DAY, SHIFT

    @Column(name = "expected_revenue", nullable = false, precision = 14, scale = 2)
    private BigDecimal expectedRevenue = BigDecimal.ZERO;

    @Column(name = "received_cash", nullable = false, precision = 14, scale = 2)
    private BigDecimal receivedCash = BigDecimal.ZERO;

    @Column(name = "received_pos", nullable = false, precision = 14, scale = 2)
    private BigDecimal receivedPos = BigDecimal.ZERO;

    @Column(name = "received_transfer", nullable = false, precision = 14, scale = 2)
    private BigDecimal receivedTransfer = BigDecimal.ZERO;

    @Column(name = "total_received", nullable = false, precision = 14, scale = 2)
    private BigDecimal totalReceived = BigDecimal.ZERO;

    @Column(nullable = false, precision = 14, scale = 2)
    private BigDecimal variance = BigDecimal.ZERO;

    @Column(name = "variance_percent", nullable = false, precision = 8, scale = 4)
    private BigDecimal variancePercent = BigDecimal.ZERO;

    @Column(name = "tank_delta_liters", precision = 12, scale = 4)
    private BigDecimal tankDeltaLiters;

    @Column(name = "pump_liters", precision = 12, scale = 4)
    private BigDecimal pumpLiters;

    @Column(nullable = false)
    private String status = "OK"; // OK, WARN, CRITICAL

    @Column(name = "computed_at", nullable = false)
    private Instant computedAt = Instant.now();
}
