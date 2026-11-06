package app.jieshui;

import android.content.Context;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 用 Android Keystore 里的 AES-256-GCM 密钥加密本地敏感值（token / 手机号）。
 *
 * 为什么需要：SharedPreferences 是明文 XML，root 过的设备、adb backup、
 * 云备份、以及部分"手机管家"类应用都能直接读到。Keystore 的密钥由 TEE/StrongBox
 * 保管，导出不来，即使拿到 XML 也解不开。
 *
 * 降级策略：极少数机型 Keystore 不可用（初始化失败），此时退回明文并打标记，
 * 保证功能不因此崩溃——安全加固不能把 App 弄坏。
 */
public final class Secure {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "jieshui.vault.v1";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int TAG_BITS = 128;
    /** 新格式前缀；老的纯 Base64 值没有前缀，读取时走兼容分支。 */
    public static final String PREFIX = "v2:";
    /** Keystore 不可用时的降级前缀（仍是明文，但至少能识别出"未加密"）。 */
    private static final String PREFIX_PLAIN = "p1:";

    private Secure() { }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            KeyStore.Entry e = ks.getEntry(ALIAS, null);
            if (e instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) e).getSecretKey();
            }
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(
                ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256);
        // 不要求用户认证：这是个人工具，解锁屏幕后应能直接用（否则扫码时还要再验一次指纹）。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            b.setInvalidatedByBiometricEnrollment(false);
        }
        kg.init(b.build());
        return kg.generateKey();
    }

    /** 加密。失败时返回带 p1: 前缀的明文，保证调用方永远拿到可用值。 */
    public static String encrypt(Context c, String plain) {
        if (plain == null || plain.isEmpty()) return "";
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(plain.getBytes("UTF-8"));
            byte[] out = new byte[1 + iv.length + ct.length];
            out[0] = (byte) iv.length;
            System.arraycopy(iv, 0, out, 1, iv.length);
            System.arraycopy(ct, 0, out, 1 + iv.length, ct.length);
            return PREFIX + Base64.encodeToString(out, Base64.NO_WRAP);
        } catch (Throwable t) {
            return PREFIX_PLAIN + Base64.encodeToString(plain.getBytes(), Base64.NO_WRAP);
        }
    }

    /** 解密。兼容三种存量格式：v2:密文 / p1:降级明文 / 老版无前缀 Base64 明文。 */
    public static String decrypt(Context c, String stored) {
        if (stored == null || stored.isEmpty()) return "";
        if (stored.startsWith(PREFIX_PLAIN)) {
            try {
                return new String(Base64.decode(stored.substring(PREFIX_PLAIN.length()), Base64.NO_WRAP), "UTF-8");
            } catch (Exception e) {
                return "";
            }
        }
        if (stored.startsWith(PREFIX)) {
            try {
                byte[] all = Base64.decode(stored.substring(PREFIX.length()), Base64.NO_WRAP);
                int ivLen = all[0] & 0xFF;
                if (ivLen <= 0 || ivLen >= all.length) return "";
                byte[] iv = new byte[ivLen];
                byte[] ct = new byte[all.length - 1 - ivLen];
                System.arraycopy(all, 1, iv, 0, ivLen);
                System.arraycopy(all, 1 + ivLen, ct, 0, ct.length);
                Cipher cipher = Cipher.getInstance(TRANSFORM);
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
                return new String(cipher.doFinal(ct), "UTF-8");
            } catch (Throwable t) {
                // 密钥被系统清掉（恢复出厂/换机/清除凭据）时只能丢弃旧值
                return "";
            }
        }
        // 老版本：Base64(明文)
        try {
            return new String(Base64.decode(stored, Base64.NO_WRAP), "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    /** 判断存量值是否已是加密格式（用于迁移）。 */
    public static boolean isEncrypted(String stored) {
        return stored != null && stored.startsWith(PREFIX);
    }
}
