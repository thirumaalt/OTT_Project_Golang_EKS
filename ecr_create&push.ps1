<#
.SYNOPSIS
    Automates the creation of AWS ECR repositories and the Build/Tag/Push 
    pipeline for the MyFlix microservices architecture on Windows.
#>

# ==============================================================================
# CONFIGURATION
# ==============================================================================
$ACCOUNT_ID   = "025211337216"  # <-- REPLACE WITH YOUR AWS ACCOUNT ID
$REGION       = "ap-south-1"
$TAG          = "v1"
$ECR_REGISTRY = "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# List of all 13 microservices
$services = @(
    "admin-dashboard", "auth-service", "api-gateway", "metadata-service", 
    "frontend-ui", "media-library-service", "transcoding-service", 
    "interaction-service", "payment-service", "recommendation-service", 
    "subscription-service", "user-service", "watchhistory-service"
)

Write-Host "🚀 Starting MyFlix ECR Deployment Pipeline..." -ForegroundColor Green
Write-Host "📍 Target Region: $REGION"
Write-Host "🆔 AWS Account ID: $ACCOUNT_ID"
Write-Host "--------------------------------------------------"

# ==============================================================================
# STEP 1: CREATE ECR REPOSITORIES (IF THEY DON'T EXIST)
# ==============================================================================
Write-Host "`n📦 Checking/Creating ECR Repositories..." -ForegroundColor Yellow

foreach ($svc in $services) {
    $repoName = "myflix/$svc"
    
    # Check if repo already exists to prevent error spam
    $repoCheck = aws ecr describe-repositories --repository-names $repoName --region $REGION 2>$null
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Creating repository: $repoName" -ForegroundColor Cyan
        aws ecr create-repository `
            --repository-name $repoName `
            --image-scanning-configuration scanOnPush=true `
            --image-tag-mutability IMMUTABLE `
            --region $REGION | Out-Null
    } else {
        Write-Host "Repository $repoName already exists. Skipping creation." -ForegroundColor Gray
    }
}

# ==============================================================================
# STEP 2: AUTHENTICATE DOCKER WITH ECR
# ==============================================================================
Write-Host "`n🔐 Authenticating Docker client with ECR..." -ForegroundColor Yellow

try {
    (aws ecr get-login-password --region $REGION) | docker login --username AWS --password-stdin $ECR_REGISTRY
    if ($LASTEXITCODE -ne 0) { throw "Docker login failed." }
} catch {
    Write-Error "Failed to authenticate with AWS ECR. Ensure your AWS credentials are valid."
    Exit
}

# ==============================================================================
# STEP 3: BUILD, TAG, AND PUSH IMAGES
# ==============================================================================
Write-Host "`n🏗️ Starting Build and Push Loop..." -ForegroundColor Yellow

foreach ($svc in $services) {
    if (Test-Path $svc) {
        Write-Host "`n==================================================" -ForegroundColor Magenta
        Write-Host " PROCESSING: $svc" -ForegroundColor Magenta
        Write-Host "==================================================" -ForegroundColor Magenta
        
        # Navigate to service directory
        Push-Location $svc
        
        if (Test-Path "Dockerfile.eks") {
            
            # 1. Build for EKS standard architecture (linux/amd64)
            Write-Host "🔨 Building linux/amd64 image..." -ForegroundColor Cyan
            docker buildx build --platform linux/amd64 -f Dockerfile.eks -t "myflix/$svc:$TAG" .
            
            # 2. Tag for remote ECR repository
            Write-Host "🏷️ Tagging image..." -ForegroundColor Cyan
            docker tag "myflix/$svc:$TAG" "${ECR_REGISTRY}/myflix/$svc:$TAG"
            
            # 3. Push to ECR
            Write-Host "📤 Pushing to AWS ECR..." -ForegroundColor Cyan
            docker push "${ECR_REGISTRY}/myflix/$svc:$TAG"
            
            Write-Host "✅ Successfully deployed $svc:$TAG" -ForegroundColor Green
        } else {
            Write-Warning "⚠️ [SKIPPED] Dockerfile.eks not found in $svc directory."
        }
        
        # Return to parent root directory safely
        Pop-Location
    } else {
        Write-Warning "❌ [SKIPPED] Directory '$svc' does not exist in the current path."
    }
}

Write-Host "`n🎉 Pipeline completed successfully!" -ForegroundColor Green