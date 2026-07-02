package com.fuelops.normalization;

import io.hypersistence.utils.hibernate.type.json.JsonType;
import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.Type;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "canonical_event")
@Data
@NoArgsConstructor
public class CanonicalEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "raw_event_id")
    private UUID rawEventId;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "station_id", nullable = false)
    private UUID stationId;

    // FUEL_DISPENSE, TANK_READING, PRICE_CHANGE, DELIVERY, PAYMENT
    @Column(name = "event_type", nullable = false)
    private String eventType;

    @Column(name = "event_time", nullable = false)
    private Instant eventTime;

    @Column(name = "processed_at", nullable = false)
    private Instant processedAt = Instant.now();

    @Type(JsonType.class)
    @Column(columnDefinition = "jsonb", nullable = false)
    private Map<String, Object> data;
}
