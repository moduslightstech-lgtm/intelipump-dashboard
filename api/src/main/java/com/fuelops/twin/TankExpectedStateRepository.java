package com.fuelops.twin;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface TankExpectedStateRepository extends JpaRepository<TankExpectedState, UUID> {
    Optional<TankExpectedState> findByTankId(UUID tankId);

    List<TankExpectedState> findByStationId(UUID stationId);
}
