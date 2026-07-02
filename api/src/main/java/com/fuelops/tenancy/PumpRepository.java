package com.fuelops.tenancy;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface PumpRepository extends JpaRepository<Pump, UUID> {
    List<Pump> findByStationId(UUID stationId);

    List<Pump> findByTenantId(UUID tenantId);

    List<Pump> findByStationIdAndActive(UUID stationId, boolean active);
}
