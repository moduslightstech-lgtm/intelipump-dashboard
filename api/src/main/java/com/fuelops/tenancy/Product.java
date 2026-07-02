package com.fuelops.tenancy;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "product")
@Data
@NoArgsConstructor
public class Product {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(nullable = false)
    private String code; // PMS, AGO, DPK

    @Column(nullable = false)
    private String name;

    @Column(nullable = false, precision = 12, scale = 4)
    private BigDecimal unitPrice = BigDecimal.ZERO;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();
}
