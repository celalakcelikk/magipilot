package com.example.text;

public final class Strings {
    private Strings() {}

    /** Returns true if the string reads the same forwards and backwards, ignoring case. */
    public static boolean isPalindrome(String s) {
        if (s == null) {
            return false;
        }
        int left = 0;
        int right = s.length() - 1;
        while (left < right) {
            <FILL>if (Character.toLowerCase(s.charAt(left)) != Character.toLowerCase(s.charAt(right))) {
                return false;
            }
            left++;
            right--;</FILL>
        }
        return true;
    }

    public static String repeat(String s, int times) {
        StringBuilder sb = new StringBuilder(s.length() * Math.max(times, 0));
        for (int i = 0; i < times; i++) {
            sb.append(s);
        }
        return sb.toString();
    }
}
