package com.fuelops.alerts;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/alerts")
@RequiredArgsConstructor
@Tag(name = "Alerts", description = "Alert management endpoints")
public class AlertController {

    private final AlertRepository alertRepository;

    @GetMapping
    @Operation(summary = "List alerts filtered by status and/or type")
    public ResponseEntity<List<Alert>> getAlerts(
            @RequestHeader("X-Tenant-Id") UUID tenantId,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String type) {

        List<Alert> alerts;
        if (status != null && type != null) {
            alerts = alertRepository.findByTenantIdOrderByTriggeredAtDesc(tenantId).stream()
                    .filter(a -> status.equals(a.getStatus()) && type.equals(a.getAlertType()))
                    .toList();
        } else if (status != null) {
            alerts = alertRepository.findByTenantIdAndStatusOrderByTriggeredAtDesc(tenantId, status);
        } else if (type != null) {
            alerts = alertRepository.findByTenantIdAndAlertTypeOrderByTriggeredAtDesc(tenantId, type);
        } else {
            alerts = alertRepository.findByTenantIdOrderByTriggeredAtDesc(tenantId);
        }

        return ResponseEntity.ok(alerts);
    }

    @PatchMapping("/{alertId}/acknowledge")
    @Operation(summary = "Acknowledge an alert")
    public ResponseEntity<Alert> acknowledge(@PathVariable UUID alertId) {
        return alertRepository.findById(alertId)
                .map(alert -> {
                    alert.setStatus("ACKNOWLEDGED");
                    alert.setAcknowledgedAt(Instant.now());
                    return ResponseEntity.ok(alertRepository.save(alert));
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @PatchMapping("/{alertId}/resolve")
    @Operation(summary = "Resolve an alert")
    public ResponseEntity<Alert> resolve(@PathVariable UUID alertId) {
        return alertRepository.findById(alertId)
                .map(alert -> {
                    alert.setStatus("RESOLVED");
                    alert.setResolvedAt(Instant.now());
                    return ResponseEntity.ok(alertRepository.save(alert));
                })
                .orElse(ResponseEntity.notFound().build());
    }

    @GetMapping("/summary")
    @Operation(summary = "Alert count summary by status and type")
    public ResponseEntity<?> summary(@RequestHeader("X-Tenant-Id") UUID tenantId) {
        var all = alertRepository.findByTenantIdOrderByTriggeredAtDesc(tenantId);
        long open = all.stream().filter(a -> "OPEN".equals(a.getStatus())).count();
        long acked = all.stream().filter(a -> "ACKNOWLEDGED".equals(a.getStatus())).count();
        long resolved = all.stream().filter(a -> "RESOLVED".equals(a.getStatus())).count();
        long variance = all.stream().filter(a -> "VARIANCE".equals(a.getAlertType())).count();
        long dataGap = all.stream().filter(a -> "DATA_GAP".equals(a.getAlertType())).count();

        return ResponseEntity.ok(Map.of(
                "total", all.size(), "open", open, "acknowledged", acked, "resolved", resolved,
                "byType", Map.of("VARIANCE", variance, "DATA_GAP", dataGap)));
    }
}
