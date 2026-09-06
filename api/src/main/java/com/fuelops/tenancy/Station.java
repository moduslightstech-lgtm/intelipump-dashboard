package com.fuelops.tenancy;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "station")
@Data
@NoArgsConstructor
public class Station {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(nullable = false)
    private String name;

    private String location;

    @Column(nullable = false)
    private String timezone = "Africa/Lagos";

    @Column(nullable = false)
    private boolean active = true;

    @Column(name = "external_id")
    private String externalId;

    @Column(name = "last_seen_at")
    private Instant lastSeenAt;

    @Column(name = "status")
    private String status = "ONLINE";

    @Column(nullable = false)
    private Instant createdAt = Instant.now();
}
