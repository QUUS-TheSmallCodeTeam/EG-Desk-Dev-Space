#!/bin/bash
# EG-DESK External References Setup Script

echo "🚀 Setting up EG-DESK external references..."

cd "references" || exit 1

# Function to clone or update repository with nested structure
clone_or_update() {
    local url=$1
    local dir=$2
    local name=$3

    # Create parent directory if not exists
    mkdir -p "$dir"

    if [ -d "$dir/$dir" ]; then
        echo "📦 Updating $name..."
        cd "$dir/$dir" && git pull --depth 1 && cd ../..
    else
        echo "📥 Cloning $name (shallow)..."
        cd "$dir"
        git clone --depth 1 "$url" "$dir"
        # Create online_references.md if not exists
        [ ! -f "online_references.md" ] && touch "online_references.md"
        cd ..
    fi
}

# Clone/update external repositories (large external projects)
clone_or_update "https://github.com/eclipse-theia/theia.git" "theia" "Theia Framework"
clone_or_update "https://github.com/microsoft/playwright.git" "playwright" "Playwright Testing"
clone_or_update "https://github.com/puppeteer/puppeteer.git" "puppeteer" "Puppeteer Automation"
clone_or_update "https://github.com/google-gemini/gemini-cli.git" "gemini-cli" "Google Gemini CLI"

# Clone infinite-canvas
clone_or_update "https://github.com/emilefokkema/infinite-canvas.git" "infinite-canvas" "Infinite Canvas"

# Note: claude-agent-sdk is project-specific resource already included
# EG-DESK ideas are managed in the ideas/ folder (features and brainstorming)

cd ..

echo "✅ External references setup complete!"
echo ""
echo "📂 Cloned repositories:"
echo "   - references/theia/theia/ (~54MB)"
echo "   - references/playwright/playwright/ (~100MB)"
echo "   - references/puppeteer/puppeteer/ (~20MB)"
echo "   - references/gemini-cli/gemini-cli/ (~10MB)"
echo "   - references/infinite-canvas/infinite-canvas/ (~2MB)"
echo ""
echo "💡 To update references later, run: ./setup.sh"
