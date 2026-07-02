package com.fuelops.twin;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.UpdateTimestamp;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "tank_expected_state")
@Data
@NoArgsConstructor
public class TankExpectedState {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "station_id", nullable = false)
    private UUID stationId;

    @Column(name = "tank_id", nullable = false, unique = true)
    private UUID tankId;

    @Column(name = "expected_liters", nullable = false, precision = 12, scale = 2)
    private BigDecimal expectedLiters = BigDecimal.ZERO;

    @Column(name = "init_liters", nullable = false, precision = 12, scale = 2)
    private BigDecimal initLiters = BigDecimal.ZERO;

    @UpdateTimestamp
    @Column(name = "last_updated_at", nullable = false)
    private Instant lastUpdatedAt;
}
