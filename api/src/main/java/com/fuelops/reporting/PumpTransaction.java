package com.fuelops.reporting;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Data;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "pump_transactions")
@Data
public class PumpTransaction {

    @Id
    private String id;

    @Column(name = "tenant_id", nullable = false)
    private UUID tenantId;

    @Column(name = "station_id", nullable = false)
    private String stationId;

    @Column(name = "pump_id", nullable = false)
    private String pumpId;

    @Column(name = "nozzle_id", nullable = false)
    private String nozzleId;

    @Column(nullable = false)
    private String product;

    @Column(name = "volume_liters", nullable = false)
    private BigDecimal volumeLiters;

    @Column(nullable = false)
    private BigDecimal amount;

    @Column(nullable = false)
    private String currency;

    @Column(name = "price_per_liter", nullable = false)
    private BigDecimal pricePerLiter;

    @Column(name = "raw_frame")
    private String rawFrame;

    @Column(nullable = false)
    private String status;

    @Column(name = "source_topic")
    private String sourceTopic;

    @Column(name = "device_timestamp", nullable = false)
    private Instant deviceTimestamp;

    @Column(name = "received_at", nullable = false)
    private Instant receivedAt;
}
