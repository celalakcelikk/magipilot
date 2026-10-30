package com.example.users;

import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Collectors;

public class UserService {
    public record User(String id, String email, boolean active, Instant lastLogin) {}

    private final List<User> users;

    public UserService(List<User> users) {
        this.users = List.copyOf(users);
    }

    /** Emails of active users, most recent login first. */
    public List<String> activeEmails() {
        return users.stream()
                <FILL>.filter(User::active)
                .sorted(Comparator.comparing(User::lastLogin).reversed())
                .map(User::email)</FILL>
                .collect(Collectors.toList());
    }

    public long countActive() {
        return users.stream().filter(User::active).count();
    }
}
