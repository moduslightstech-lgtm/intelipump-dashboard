package com.fuelops.reporting;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

@Repository
public interface PumpTransactionRepository extends JpaRepository<PumpTransaction, String>, JpaSpecificationExecutor<PumpTransaction> {

    long countByStationIdAndDeviceTimestampAfter(UUID stationId, Instant since);

    @Query("SELECT COALESCE(SUM(t.volumeLiters), 0) FROM PumpTransaction t WHERE t.stationId = :stationId AND t.deviceTimestamp >= :since")
    BigDecimal sumVolumeByStationIdAndDeviceTimestampAfter(UUID stationId, Instant since);

    @Query("SELECT COALESCE(SUM(t.amount), 0) FROM PumpTransaction t WHERE t.stationId = :stationId AND t.deviceTimestamp >= :since")
    BigDecimal sumAmountByStationIdAndDeviceTimestampAfter(UUID stationId, Instant since);

    long countByPumpIdAndDeviceTimestampAfter(UUID pumpId, Instant since);

    @Query("SELECT COALESCE(SUM(t.volumeLiters), 0) FROM PumpTransaction t WHERE t.pumpId = :pumpId AND t.deviceTimestamp >= :since")
    BigDecimal sumVolumeByPumpIdAndDeviceTimestampAfter(UUID pumpId, Instant since);

    @Query("SELECT COALESCE(SUM(t.amount), 0) FROM PumpTransaction t WHERE t.pumpId = :pumpId AND t.deviceTimestamp >= :since")
    BigDecimal sumAmountByPumpIdAndDeviceTimestampAfter(UUID pumpId, Instant since);

    List<PumpTransaction> findTop10ByStationIdOrderByDeviceTimestampDesc(UUID stationId);
}
