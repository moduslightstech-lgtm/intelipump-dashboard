package com.fuelops.normalization;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface CanonicalEventRepository extends JpaRepository<CanonicalEvent, UUID> {

        List<CanonicalEvent> findByStationIdAndEventTypeAndEventTimeBetweenOrderByEventTimeAsc(
                        UUID stationId, String eventType, Instant from, Instant to);

        List<CanonicalEvent> findByStationIdAndEventTimeBetweenOrderByEventTimeAsc(
                        UUID stationId, Instant from, Instant to);

        @Query("SELECT MAX(c.eventTime) FROM CanonicalEvent c WHERE c.stationId = :stationId AND c.eventType = :eventType")
        Optional<Instant> findLatestEventTimeByStationAndType(UUID stationId, String eventType);

        List<CanonicalEvent> findByTenantIdAndEventTypeAndEventTimeBetween(
                        UUID tenantId, String eventType, Instant from, Instant to);

        @Query(value = """
                        SELECT COALESCE(SUM(CAST(data->>'liters' AS numeric) * CAST(data->>'unitPrice' AS numeric)), 0)
                        FROM canonical_event
                        WHERE station_id = :stationId
                          AND event_type = 'FUEL_DISPENSE'
                          AND event_time BETWEEN :from AND :to
                        """, nativeQuery = true)
        BigDecimal sumExpectedRevenueForStation(UUID stationId, Instant from, Instant to);

        @Query(value = """
                        SELECT COALESCE(SUM(CAST(data->>'liters' AS numeric)), 0)
                        FROM canonical_event
                        WHERE station_id = :stationId
                          AND event_type = 'FUEL_DISPENSE'
                          AND event_time BETWEEN :from AND :to
                        """, nativeQuery = true)
        BigDecimal sumPumpLitersForStation(UUID stationId, Instant from, Instant to);
}
