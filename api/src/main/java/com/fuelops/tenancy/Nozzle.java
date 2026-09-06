package com.fuelops.tenancy;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "nozzle")
@Data
@NoArgsConstructor
public class Nozzle {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "pump_id", nullable = false)
    private UUID pumpId;

    @Column(name = "station_id", nullable = false)
    private UUID stationId;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "product_id", nullable = false)
    private UUID productId;

    @Column(nullable = false)
    private String label;

    @Column(nullable = false)
    private boolean active = true;

    @Column(name = "external_id")
    private String externalId;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();
}
