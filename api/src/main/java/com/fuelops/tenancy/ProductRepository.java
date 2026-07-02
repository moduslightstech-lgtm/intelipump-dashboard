package com.fuelops.tenancy;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface ProductRepository extends JpaRepository<Product, UUID> {
    List<Product> findByTenantId(UUID tenantId);

    java.util.Optional<Product> findByTenantIdAndCode(UUID tenantId, String code);
}
