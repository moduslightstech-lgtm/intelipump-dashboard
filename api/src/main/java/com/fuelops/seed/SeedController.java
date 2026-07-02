package com.fuelops.seed;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/seed")
@RequiredArgsConstructor
@Tag(name = "Seed", description = "Demo seed data endpoints")
public class SeedController {

    private final SeedDataGenerator seedDataGenerator;

    @PostMapping("/run")
    @Operation(summary = "Generate demo seed data (1 tenant, 3 stations, 7 days)")
    public ResponseEntity<Map<String, Object>> runSeed() {
        return ResponseEntity.ok(seedDataGenerator.seed());
    }
}
