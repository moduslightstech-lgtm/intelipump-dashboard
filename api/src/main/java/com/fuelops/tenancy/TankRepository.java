package com.fuelops.tenancy;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface TankRepository extends JpaRepository<Tank, UUID> {
    List<Tank> findByStationId(UUID stationId);

    List<Tank> findByTenantId(UUID tenantId);

    List<Tank> findByStationIdAndProductId(UUID stationId, UUID productId);
}
