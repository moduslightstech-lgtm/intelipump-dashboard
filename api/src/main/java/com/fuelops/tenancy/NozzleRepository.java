package com.fuelops.tenancy;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface NozzleRepository extends JpaRepository<Nozzle, UUID> {
    List<Nozzle> findByStationId(UUID stationId);

    List<Nozzle> findByPumpId(UUID pumpId);

    List<Nozzle> findByStationIdAndActive(UUID stationId, boolean active);
}
