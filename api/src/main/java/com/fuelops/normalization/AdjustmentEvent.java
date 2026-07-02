package com.fuelops.normalization;

import io.hypersistence.utils.hibernate.type.json.JsonType;
import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.Type;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "adjustment_event")
@Data
@NoArgsConstructor
public class AdjustmentEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "station_id", nullable = false)
    private UUID stationId;

    @Column(name = "user_id")
    private UUID userId;

    @Column(nullable = false, columnDefinition = "TEXT")
    private String reason;

    @Column(name = "window_from", nullable = false)
    private Instant windowFrom;

    @Column(name = "window_to", nullable = false)
    private Instant windowTo;

    @Column(name = "amount_adjustment", precision = 14, scale = 2)
    private BigDecimal amountAdjustment = BigDecimal.ZERO;

    @Column(name = "liters_adjustment", precision = 12, scale = 4)
    private BigDecimal litersAdjustment = BigDecimal.ZERO;

    @Type(JsonType.class)
    @Column(name = "attachment_meta", columnDefinition = "jsonb")
    private Map<String, Object> attachmentMeta = Map.of();

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();
}
