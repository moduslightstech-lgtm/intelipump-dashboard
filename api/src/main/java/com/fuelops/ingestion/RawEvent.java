package com.fuelops.ingestion;

import io.hypersistence.utils.hibernate.type.json.JsonType;
import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.Type;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "raw_event", uniqueConstraints = @UniqueConstraint(name = "uq_raw_event_idempotency", columnNames = {
        "tenant_id", "station_id", "source", "event_id" }))
@Data
@NoArgsConstructor
public class RawEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "station_id", nullable = false)
    private UUID stationId;

    @Column(nullable = false)
    private String source = "pts2";

    @Column(name = "event_id", nullable = false)
    private String eventId;

    @Column(name = "event_type", nullable = false)
    private String eventType;

    @Type(JsonType.class)
    @Column(columnDefinition = "jsonb", nullable = false)
    private Map<String, Object> payload;

    @Column(name = "device_time")
    private Instant deviceTime;

    @Column(name = "received_time", nullable = false)
    private Instant receivedTime = Instant.now();
}
