package com.fuelops.auth;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
@Tag(name = "Auth", description = "Authentication endpoints")
public class AuthController {

    private final AppUserRepository userRepository;
    private final JwtTokenProvider jwtTokenProvider;
    private final PasswordEncoder passwordEncoder;

    record LoginRequest(@NotBlank String username, @NotBlank String password) {
    }

    record LoginResponse(String token, String username, String tenantId, java.util.List<String> roles) {
    }

    @PostMapping("/login")
    @Operation(summary = "Login and receive JWT token")
    public ResponseEntity<?> login(@Valid @RequestBody LoginRequest request) {
        var user = userRepository.findByUsername(request.username())
                .orElseThrow(() -> new RuntimeException("Invalid credentials"));

        if (!user.isActive()) {
            return ResponseEntity.status(403).body(Map.of("error", "Account disabled"));
        }

        if (!passwordEncoder.matches(request.password(), user.getPasswordHash())) {
            return ResponseEntity.status(401).body(Map.of("error", "Invalid credentials"));
        }

        String token = jwtTokenProvider.generateToken(user);
        return ResponseEntity.ok(new LoginResponse(
                token,
                user.getUsername(),
                user.getTenantId().toString(),
                user.getRoles()));
    }

    @GetMapping("/me")
    @Operation(summary = "Get current user info")
    public ResponseEntity<?> me(jakarta.servlet.http.HttpServletRequest request) {
        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            return ResponseEntity.status(401).body(Map.of("error", "Not authenticated"));
        }
        String token = header.substring(7);
        if (!jwtTokenProvider.isTokenValid(token)) {
            return ResponseEntity.status(401).body(Map.of("error", "Invalid token"));
        }
        return ResponseEntity.ok(Map.of(
                "username", jwtTokenProvider.getUsernameFromToken(token),
                "tenantId", jwtTokenProvider.getTenantIdFromToken(token).toString(),
                "roles", jwtTokenProvider.getRolesFromToken(token)));
    }
}
