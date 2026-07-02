package com.fuelops.twin;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface StationStateSnapshotRepository extends JpaRepository<StationStateSnapshot, UUID> {
    Optional<StationStateSnapshot> findByStationId(UUID stationId);

    List<StationStateSnapshot> findByTenantId(UUID tenantId);
}
