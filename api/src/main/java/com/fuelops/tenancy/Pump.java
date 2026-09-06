package com.fuelops.tenancy;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "pump")
@Data
@NoArgsConstructor
public class Pump {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "station_id", nullable = false)
    private UUID stationId;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(nullable = false)
    private String label;

    @Column(nullable = false)
    private boolean active = true;

    @Column(name = "external_id")
    private String externalId;

    @Column(name = "last_seen_at")
    private Instant lastSeenAt;

    @Column(name = "status")
    private String status = "IDLE";

    @Column(nullable = false)
    private Instant createdAt = Instant.now();
}
