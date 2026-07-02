package com.fuelops.alerts;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface AlertRepository extends JpaRepository<Alert, UUID> {
    List<Alert> findByTenantIdAndStatusOrderByTriggeredAtDesc(UUID tenantId, String status);

    List<Alert> findByTenantIdOrderByTriggeredAtDesc(UUID tenantId);

    List<Alert> findByStationIdAndAlertTypeAndStatus(UUID stationId, String alertType, String status);

    List<Alert> findByStationIdOrderByTriggeredAtDesc(UUID stationId);

    List<Alert> findByTenantIdAndAlertTypeOrderByTriggeredAtDesc(UUID tenantId, String alertType);
}
