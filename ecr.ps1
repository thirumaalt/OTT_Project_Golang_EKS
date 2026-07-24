# ecr.ps1

$REGION = "ap-south-1"

# Get AWS Account ID
$ACCOUNT_ID = aws sts get-caller-identity --query Account --output text
$REGISTRY = "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

# Services
$SERVICES = @(
    "analytics-service",
    "api-gateway",
    "auth-service",
    "interaction-service",
    "media-library-service",
    "metadata-service",
    "payment-service",
    "recommendation-service",
    "subscription-service",
    "transcoding-service",
    "user-service",
    "watchhistory-service",
    "frontend-ui",
    "admin-dashboard"
)

Write-Host "Account ID : $ACCOUNT_ID"
Write-Host "Registry   : $REGISTRY"

# Create ECR repositories
foreach ($svc in $SERVICES) {
    Write-Host "Creating ECR repository: myflix/$svc"

    aws ecr create-repository `
        --repository-name "myflix/$svc" `
        --region $REGION 2>$null
}

# Login to ECR
aws ecr get-login-password --region $REGION |
docker login --username AWS --password-stdin $REGISTRY

if ($LASTEXITCODE -ne 0) {
    Write-Host "ECR Login Failed!"
    exit 1
}

# Build and Push Images
foreach ($svc in $SERVICES) {

    if (!(Test-Path $svc)) {
        Write-Host "Skipping $svc - Directory not found"
        continue
    }

    if (Test-Path "$svc\Dockerfile.eks") {
        $DOCKERFILE = "Dockerfile.eks"
    }
    elseif (Test-Path "$svc\Dockerfile") {
        $DOCKERFILE = "Dockerfile"
    }
    else {
        Write-Host "Skipping $svc - No Dockerfile found"
        continue
    }

    $LOCAL_IMAGE = "myflix/${svc}:v1"
    $ECR_IMAGE = "$REGISTRY/myflix/${svc}:v1"

    Write-Host ""
    Write-Host "=========================================="
    Write-Host "Building : $svc"
    Write-Host "Dockerfile : $DOCKERFILE"
    Write-Host "Local Image : $LOCAL_IMAGE"
    Write-Host "ECR Image   : $ECR_IMAGE"
    Write-Host "=========================================="

    docker build `
        -f "$svc\$DOCKERFILE" `
        -t $LOCAL_IMAGE `
        $svc

    if ($LASTEXITCODE -ne 0) {
        Write-Host "Build failed for $svc"
        continue
    }

    docker tag $LOCAL_IMAGE $ECR_IMAGE

    if ($LASTEXITCODE -ne 0) {
        Write-Host "Tag failed for $svc"
        continue
    }

    docker push $ECR_IMAGE

    if ($LASTEXITCODE -ne 0) {
        Write-Host "Push failed for $svc"
        continue
    }

    Write-Host "Successfully pushed $ECR_IMAGE"
}

Write-Host ""
Write-Host "All completed."