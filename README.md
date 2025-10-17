# Build a Standalone Executable with `pkg`

This guide will walk you through the process of packaging your Node.js application into a standalone executable using the `pkg` package. Once built, the executable can run on Windows, macOS, or Linux without requiring Node.js to be installed.

## Steps to Package Your Application

### Step 1: Install `pkg`

First, you need to install `pkg` as a development dependency in your project. Open your terminal or command prompt in the root directory of your project and run the following command:

```bash
npm install pkg --save-dev
```

### Step 2: Update `package.json`

Next, you need to tell `pkg` which files to include in the final executable. This is done by adding a `bin` entry and a `pkg` section to your `package.json` file.

1. **`bin` entry**: Points to your main script that starts your application.
2. **`pkg.assets` array**: Lists all the non-JavaScript files (like your HTML files) that need to be bundled into the executable.

Here's an example of what your `package.json` might look like after these modifications:

```json
{
  "name": "your-app",
  "version": "1.0.0",
  "description": "Your project description",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "build": "pkg . --targets node16-win-x64,node16-macos-x64,node16-linux-x64"
  },
  "bin": "index.js",
  "pkg": {
    "assets": [
      "public/**/*",
      "views/**/*"
    ]
  },
  "devDependencies": {
    "pkg": "^5.3.0"
  }
}
```

Make sure to adjust the `bin` path and the `assets` array according to your project structure.

### Step 3: Run the Build Command

Once your `package.json` is updated, you're ready to build the executables. The following build script is included in your `package.json`:

```bash
npm run build
```

This will instruct `pkg` to create executables for Windows, macOS, and Linux based on the configuration in `package.json`.

### Step 4: Locate Your Executables

After the build process is complete, you will find the new executable files in your project directory (e.g., `your-app-server.exe` for Windows). These executables are ready to be run directly on any compatible system without needing Node.js installed.

For example:

- **Windows**: `your-app-server.exe`
- **macOS**: `your-app-server-macos`
- **Linux**: `your-app-server-linux`

### Troubleshooting

#### `xdg-open` Warning During Build

You may see a warning like the following when you run `npm run build`:

```bash
Warning Cannot include file ... node_modules/open/xdg-open into executable.
```

**What it means**:  
This is a known issue when packaging an application that uses the `open` library. This library uses a helper script called `xdg-open` to automatically open URLs and folders on Linux systems. Unfortunately, `pkg` cannot bundle this external script into your final executable.

**Impact**:  
- The build is still successful, and the executable will work on Windows and macOS.
- The Linux executable will run, but automatic opening of URLs or folders may not work.

**Workaround for Linux**:  
If you're running the executable on Linux, simply check the console output when you start the server. It will print the URL for the dashboard, for example:

```
Server is running at http://192.168.1.5:5000
```

You can copy and paste this URL into your browser manually.

## Additional Tips

- **Cross-Platform Building**: If you want to build for a specific platform, you can specify targets with the `--targets` flag in the `pkg` command, like so:

  ```bash
  pkg . --targets node16-win-x64,node16-macos-x64,node16-linux-x64
  ```

  This will build for Windows, macOS, and Linux. You can change the versions and platforms based on your needs.

- **Including Files**: If you have other files (like `.env` or configuration files), ensure they are included in the `pkg.assets` array so they are bundled with the executable.

- **Testing**: Always test your executable on the target operating systems to ensure everything works as expected.

## Conclusion

That's it! You've successfully packaged your Node.js application into a standalone executable using `pkg`. Now you can share your application without requiring users to have Node.js installed.
