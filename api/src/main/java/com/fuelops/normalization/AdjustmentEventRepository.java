package com.fuelops.normalization;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

@Repository
public interface AdjustmentEventRepository extends JpaRepository<AdjustmentEvent, UUID> {
    List<AdjustmentEvent> findByStationIdAndWindowFromBetween(UUID stationId, Instant from, Instant to);

    List<AdjustmentEvent> findByStationIdOrderByCreatedAtDesc(UUID stationId);

    @Query("SELECT COALESCE(SUM(a.amountAdjustment), 0) FROM AdjustmentEvent a WHERE a.stationId = :stationId AND a.windowFrom >= :from AND a.windowTo <= :to")
    BigDecimal sumAdjustmentsForStation(UUID stationId, Instant from, Instant to);
}
