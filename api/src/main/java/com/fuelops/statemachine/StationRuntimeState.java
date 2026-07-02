package com.fuelops.statemachine;

import io.hypersistence.utils.hibernate.type.json.JsonType;
import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.Type;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "station_runtime_state")
@Data
@NoArgsConstructor
public class StationRuntimeState {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "station_id", nullable = false, unique = true)
    private UUID stationId;

    /** ONLINE | DEGRADED | DATA_GAP | RECONCILING | ALERTING */
    @Column(name = "state", nullable = false, length = 30)
    private String state = "ONLINE";

    @Column(name = "entered_at", nullable = false)
    private Instant enteredAt = Instant.now();

    @Column(name = "last_dispense_at")
    private Instant lastDispenseAt;

    @Column(name = "last_tank_reading_at")
    private Instant lastTankReadingAt;

    @Column(name = "last_payment_at")
    private Instant lastPaymentAt;

    @Column(name = "last_raw_received")
    private Instant lastRawReceived;

    @Type(JsonType.class)
    @Column(name = "metadata", columnDefinition = "jsonb", nullable = false)
    private Map<String, Object> metadata = Map.of();
}
