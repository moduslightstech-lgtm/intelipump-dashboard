package com.fuelops.reconciliation;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface ReconciliationResultRepository extends JpaRepository<ReconciliationResult, UUID> {

    List<ReconciliationResult> findByStationIdOrderByWindowFromDesc(UUID stationId);

    List<ReconciliationResult> findByTenantIdAndWindowFromBetweenOrderByWindowFromDesc(
            UUID tenantId, Instant from, Instant to);

    List<ReconciliationResult> findByStationIdAndWindowFromBetweenOrderByWindowFromAsc(
            UUID stationId, Instant from, Instant to);

    Optional<ReconciliationResult> findByStationIdAndWindowFromAndWindowToAndGranularity(
            UUID stationId, Instant from, Instant to, String granularity);

    List<ReconciliationResult> findByTenantIdAndStatusOrderByComputedAtDesc(UUID tenantId, String status);

    @Query("SELECT r FROM ReconciliationResult r WHERE r.tenantId = :tenantId " +
            "AND r.windowFrom >= :from ORDER BY ABS(r.variance) DESC")
    List<ReconciliationResult> findTopVariancesByTenant(UUID tenantId, Instant from);
}
