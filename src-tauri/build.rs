fn main() {
    // Release meminta admin karena kill proses milik user lain butuh privilege.
    // Debug/test sengaja asInvoker supaya `cargo test` tidak memicu UAC.
    let execution_level = if std::env::var("PROFILE").as_deref() == Ok("release") {
        "requireAdministrator"
    } else {
        "asInvoker"
    };

    let manifest = format!(
        r#"
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="{execution_level}" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
</assembly>
"#
    );

    let mut windows = tauri_build::WindowsAttributes::new();
    windows = windows.app_manifest(&manifest);
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run build script");
}
