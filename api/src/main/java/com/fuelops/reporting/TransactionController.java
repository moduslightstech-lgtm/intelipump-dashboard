package com.fuelops.reporting;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import jakarta.persistence.criteria.Predicate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/transactions")
@RequiredArgsConstructor
@Tag(name = "Transactions", description = "Transactions query endpoints")
public class TransactionController {

    private final PumpTransactionRepository pumpTransactionRepository;

    @GetMapping
    @Operation(summary = "Get paginated list of transactions with optional filters")
    public ResponseEntity<?> getTransactions(
            @RequestParam(required = false) UUID stationId,
            @RequestParam(required = false) UUID pumpId,
            @RequestParam(required = false) String product,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String startDate,
            @RequestParam(required = false) String endDate,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(defaultValue = "deviceTimestamp,desc") String sort) {

        // Parse sort
        String[] sortParts = sort.split(",");
        String property = sortParts[0];
        Sort.Direction direction = Sort.Direction.DESC;
        if (sortParts.length > 1 && "asc".equalsIgnoreCase(sortParts[1])) {
            direction = Sort.Direction.ASC;
        }
        Pageable pageable = PageRequest.of(page, size, Sort.by(direction, property));

        // Build specifications
        Specification<PumpTransaction> spec = (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            if (stationId != null) {
                predicates.add(cb.equal(root.get("stationId"), stationId.toString()));
            }
            if (pumpId != null) {
                predicates.add(cb.equal(root.get("pumpId"), pumpId.toString()));
            }
            if (product != null && !product.trim().isEmpty()) {
                predicates.add(cb.equal(cb.upper(root.get("product")), product.trim().toUpperCase()));
            }
            if (status != null && !status.trim().isEmpty()) {
                predicates.add(cb.equal(cb.upper(root.get("status")), status.trim().toUpperCase()));
            }
            if (startDate != null && !startDate.trim().isEmpty()) {
                try {
                    predicates.add(cb.greaterThanOrEqualTo(root.get("deviceTimestamp"), Instant.parse(startDate.trim())));
                } catch (Exception ignored) {}
            }
            if (endDate != null && !endDate.trim().isEmpty()) {
                try {
                    predicates.add(cb.lessThanOrEqualTo(root.get("deviceTimestamp"), Instant.parse(endDate.trim())));
                } catch (Exception ignored) {}
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };

        Page<PumpTransaction> resultPage = pumpTransactionRepository.findAll(spec, pageable);
        return ResponseEntity.ok(resultPage);
    }
}
