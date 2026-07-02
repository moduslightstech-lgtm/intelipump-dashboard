package com.fuelops.normalization;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

@Repository
public interface PaymentEventRepository extends JpaRepository<PaymentEvent, UUID> {

    List<PaymentEvent> findByStationIdAndEventTimeBetween(UUID stationId, Instant from, Instant to);

    @Query("SELECT COALESCE(SUM(p.amount), 0) FROM PaymentEvent p WHERE p.stationId = :stationId AND p.paymentType = :type AND p.eventTime BETWEEN :from AND :to")
    BigDecimal sumByStationIdAndTypeAndTimeBetween(UUID stationId, String type, Instant from, Instant to);

    @Query("SELECT COALESCE(SUM(p.amount), 0) FROM PaymentEvent p WHERE p.stationId = :stationId AND p.eventTime BETWEEN :from AND :to")
    BigDecimal sumTotalByStationIdAndTimeBetween(UUID stationId, Instant from, Instant to);
}
