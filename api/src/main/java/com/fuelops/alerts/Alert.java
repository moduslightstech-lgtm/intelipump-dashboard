package com.fuelops.alerts;

import io.hypersistence.utils.hibernate.type.json.JsonType;
import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.Type;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "alert")
@Data
@NoArgsConstructor
public class Alert {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "station_id", nullable = false)
    private UUID stationId;

    // VARIANCE, DATA_GAP, PRICE_ANOMALY
    @Column(name = "alert_type", nullable = false)
    private String alertType;

    // INFO, WARN, CRITICAL
    @Column(nullable = false)
    private String severity;

    // OPEN, ACKNOWLEDGED, RESOLVED
    @Column(nullable = false)
    private String status = "OPEN";

    @Column(nullable = false)
    private String title;

    @Type(JsonType.class)
    @Column(columnDefinition = "jsonb", nullable = false)
    private Map<String, Object> details = Map.of();

    @Column(name = "triggered_at", nullable = false)
    private Instant triggeredAt = Instant.now();

    @Column(name = "acknowledged_at")
    private Instant acknowledgedAt;

    @Column(name = "resolved_at")
    private Instant resolvedAt;
}
