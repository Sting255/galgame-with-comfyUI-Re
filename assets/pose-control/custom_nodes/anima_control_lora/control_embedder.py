import torch.nn as nn
from einops import rearrange


class ControlEmbedder(nn.Module):
    """Zero-init patch-embed for the control (pose-skeleton) latent.

    Mirrors the base PatchEmbed (spatial_patch_size=2, temporal_patch_size=1) but on the
    raw 16-channel control latent (no padding-mask channel). Zero-initialized so it adds
    nothing until trained (ControlNet zero-init). Output matches prepare_embedded_sequence's
    x_B_T_H_W_D: (B, T, H/2, W/2, model_channels).
    """

    def __init__(self, in_channels=16, spatial_patch_size=2, temporal_patch_size=1, model_channels=2048):
        super().__init__()
        self.spatial_patch_size = spatial_patch_size
        self.temporal_patch_size = temporal_patch_size
        in_features = in_channels * spatial_patch_size * spatial_patch_size * temporal_patch_size
        self.proj = nn.Linear(in_features, model_channels)
        nn.init.zeros_(self.proj.weight)
        nn.init.zeros_(self.proj.bias)

    def forward(self, control_B_C_T_H_W):
        x = rearrange(
            control_B_C_T_H_W,
            "b c (t r) (h m) (w n) -> b t h w (c r m n)",
            r=self.temporal_patch_size, m=self.spatial_patch_size, n=self.spatial_patch_size,
        )
        return self.proj(x)
