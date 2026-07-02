package com.fuelops.twin;

import io.hypersistence.utils.hibernate.type.json.JsonType;
import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.Type;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "station_state_snapshot")
@Data
@NoArgsConstructor
public class StationStateSnapshot {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "station_id", nullable = false, unique = true)
    private UUID stationId;

    // {"tankId": {"reportedLiters": 1200, "expectedLiters": 1350, "productCode":
    // "PMS", "label": "Tank 1"}}
    @Type(JsonType.class)
    @Column(name = "tank_states", columnDefinition = "jsonb", nullable = false)
    private Map<String, Object> tankStates = Map.of();

    // {"pumpId": {"label": "Pump 1", "transactionCount": 45, "totalLiters": 890.5,
    // "active": true}}
    @Type(JsonType.class)
    @Column(name = "pump_states", columnDefinition = "jsonb", nullable = false)
    private Map<String, Object> pumpStates = Map.of();

    // {"FUEL_DISPENSE": "2025-03-01T10:00:00Z", "TANK_READING":
    // "2025-03-01T08:00:00Z"}
    @Type(JsonType.class)
    @Column(name = "last_event_times", columnDefinition = "jsonb", nullable = false)
    private Map<String, Object> lastEventTimes = Map.of();

    @Column(name = "snapshot_time", nullable = false)
    private Instant snapshotTime = Instant.now();
}
