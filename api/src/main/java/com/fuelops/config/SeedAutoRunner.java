package com.fuelops.config;

import com.fuelops.seed.SeedDataGenerator;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
@Slf4j
public class SeedAutoRunner implements ApplicationRunner {

    private final SeedDataGenerator seedDataGenerator;

    @Value("${fuelops.seed.auto-run:false}")
    private boolean autoRun;

    @Override
    public void run(ApplicationArguments args) {
        if (autoRun) {
            log.info("Auto-seeding enabled. Running seed data generator...");
            try {
                var result = seedDataGenerator.seed();
                log.info("Seed result: {}", result);
            } catch (Exception e) {
                log.error("Seed failed: {}", e.getMessage(), e);
            }
        }
    }
}
