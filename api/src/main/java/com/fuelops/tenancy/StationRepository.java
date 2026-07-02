package com.fuelops.tenancy;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface StationRepository extends JpaRepository<Station, UUID> {
    List<Station> findByTenantId(UUID tenantId);

    List<Station> findByTenantIdAndActive(UUID tenantId, boolean active);
}
