package com.fuelops.tenancy;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "tank")
@Data
@NoArgsConstructor
public class Tank {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "station_id", nullable = false)
    private UUID stationId;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "product_id", nullable = false)
    private UUID productId;

    @Column(nullable = false)
    private String label;

    @Column(name = "capacity_liters", nullable = false, precision = 12, scale = 2)
    private BigDecimal capacityLiters;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();
}
