"""ComfyUI node: fuse a trained control-LoRA's ControlEmbedder into the Cosmos DiT forward.
Wraps the DIFFUSION_MODEL forward (comfy/model_patcher.py add_wrapper_with_key) to add the
control contribution at the patch-embed output; LoRA deltas on existing weights are applied
separately via LoraLoaderModelOnly upstream of this node."""


class AnimaControlApply:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "control_latent": ("LATENT",),            # VAE-encoded skeleton (use a VAEEncode node)
            "control_embedder_path": ("STRING", {"default": "adapter_model.safetensors"}),
            "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "AnimaControl"

    def apply(self, model, control_latent, control_embedder_path, strength):
        import safetensors.torch as st
        from .control_embedder import ControlEmbedder
        dit = model.model.diffusion_model
        p = next(dit.parameters())
        embedder = ControlEmbedder(in_channels=16, model_channels=getattr(dit, "model_channels", 2048))
        # Training saves the embedder INSIDE the adapter file as `diffusion_model.control_embedder.proj.*`
        # (saver keeps `control_embedder.proj.*`, base save_adapter prepends `diffusion_model.`). Strip up
        # to and including `control_embedder.`, and fail loudly if nothing matches — otherwise the embedder
        # would stay zero-init and control would be a silent no-op.
        # Resolve a bare filename against ComfyUI's loras/ dir so the same downloaded
        # adapter_model.safetensors feeds both this node and LoraLoaderModelOnly; absolute
        # paths are used as-is (the training/eval scripts pass those).
        import os
        cep = control_embedder_path
        if not os.path.isabs(cep):
            try:
                import folder_paths
                cep = folder_paths.get_full_path("loras", cep) or cep
            except Exception:
                pass
        sd = {k.split("control_embedder.", 1)[1]: v
              for k, v in st.load_file(cep).items() if "control_embedder." in k}
        assert sd, f"no control_embedder.* keys in {cep} (expected diffusion_model.control_embedder.proj.*)"
        embedder.load_state_dict(sd, strict=False)
        embedder.eval().to(p.device, p.dtype)
        ctrl = control_latent["samples"]

        def wrapper(executor, *args, **kwargs):
            # Reproduce training-time fusion (ControlInitialLayer._fuse_control): add the
            # ControlEmbedder output to the x_embedder output via a temporary forward hook,
            # removed after the call so it never leaks onto the shared DiT. strength=0 zeroes
            # control_tokens -> output unchanged (the base regression).
            control_tokens = strength * embedder(ctrl.to(p.device, p.dtype))

            def add_control(_module, _inputs, output):
                # match output's device AND dtype — at apply() the DiT may still be on CPU (ComfyUI
                # lazy-loads), so control_tokens can be built on CPU while output is on cuda at sampling.
                return output + control_tokens.to(output.device, output.dtype)

            handle = dit.x_embedder.register_forward_hook(add_control)
            try:
                return executor(*args, **kwargs)
            finally:
                handle.remove()

        m = model.clone()
        m.add_wrapper_with_key("diffusion_model", "anima_control", wrapper)
        return (m,)


NODE_CLASS_MAPPINGS = {"AnimaControlApply": AnimaControlApply}
NODE_DISPLAY_NAME_MAPPINGS = {"AnimaControlApply": "Anima Control Apply"}
