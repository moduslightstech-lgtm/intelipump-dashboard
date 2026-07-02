package com.fuelops.ingestion;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface RawEventRepository extends JpaRepository<RawEvent, UUID> {
    boolean existsByTenantIdAndStationIdAndSourceAndEventId(
            UUID tenantId, UUID stationId, String source, String eventId);

    List<RawEvent> findByStationIdOrderByReceivedTimeDesc(UUID stationId);

    @Query("SELECT MAX(r.receivedTime) FROM RawEvent r WHERE r.stationId = :stationId")
    Optional<Instant> findLastReceivedTimeByStationId(UUID stationId);

    @Query("SELECT MAX(r.receivedTime) FROM RawEvent r WHERE r.stationId = :stationId AND r.eventType = :eventType")
    Optional<Instant> findLastReceivedTimeByStationIdAndEventType(UUID stationId, String eventType);

    List<RawEvent> findByTenantIdAndStationIdAndReceivedTimeBetween(
            UUID tenantId, UUID stationId, Instant from, Instant to);
}
