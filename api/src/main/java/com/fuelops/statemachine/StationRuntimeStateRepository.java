package com.fuelops.statemachine;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface StationRuntimeStateRepository extends JpaRepository<StationRuntimeState, UUID> {
    Optional<StationRuntimeState> findByStationId(UUID stationId);

    List<StationRuntimeState> findByTenantId(UUID tenantId);
}
