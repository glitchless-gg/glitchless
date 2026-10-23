# Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#
# Makes the demo's only assets: three firework materials, /Game/Demo/M_Fireworks_A, _B and _C. Each is unlit, its
# emissive colour a procedural burst from a Custom node whose loop is unrolled, so each compiles to a long pixel
# shader with its own pipeline states. The demo draws them for the first time when the gallery's fireworks go off
# (planted problem 1). unreal/demo/run.mjs runs this before cooking:
#
#   UnrealEditor-Cmd GlitchlessDemo.uproject -run=pythonscript -script=<this file> -unattended -nullrhi
import unreal

FOLDER = '/Game/Demo'
CODE = '''
float3 c = 0;
float2 p = (UV - 0.5) * Scale;
[unroll]
for (int i = 0; i < 64; i++)
{
    float fi = i;
    float s = sin(fi * 0.37 + T * 0.9);
    float k = cos(fi * 0.53 - T * 0.7);
    p = float2(p.x * k - p.y * s, p.x * s + p.y * k) * 1.013 + float2(sin(T + fi), cos(T * 1.3 + fi)) * 0.07;
    float r = length(p);
    c += Tint * (0.012 / (0.02 + abs(r - 0.5 - 0.3 * sin(fi + T))));
    c += 0.004 * (0.5 + 0.5 * cos(float3(0.0, 2.1, 4.2) + fi * 0.21 + r * 3.0));
}
return c;
'''
VARIANTS = {'A': ((1.0, 0.35, 0.2), 3.0), 'B': ((0.2, 1.0, 0.65), 4.0), 'C': ((0.35, 0.5, 1.0), 5.0)}

tools = unreal.AssetToolsHelpers.get_asset_tools()
lib = unreal.MaterialEditingLibrary
assets = unreal.EditorAssetLibrary

for name, (tint, scale) in VARIANTS.items():
    path = f'{FOLDER}/M_Fireworks_{name}'
    if assets.does_asset_exist(path):
        assets.delete_asset(path)
    mat = tools.create_asset(f'M_Fireworks_{name}', FOLDER, unreal.Material, unreal.MaterialFactoryNew())
    mat.set_editor_property('shading_model', unreal.MaterialShadingModel.MSM_UNLIT)
    custom = lib.create_material_expression(mat, unreal.MaterialExpressionCustom, -500, 0)
    custom.set_editor_property('code', CODE)
    custom.set_editor_property('output_type', unreal.CustomMaterialOutputType.CMOT_FLOAT3)
    custom.set_editor_property('description', 'Fireworks')
    inputs = []
    for input_name in ('UV', 'T', 'Tint', 'Scale'):
        i = unreal.CustomInput()
        i.set_editor_property('input_name', input_name)
        inputs.append(i)
    custom.set_editor_property('inputs', inputs)
    uv = lib.create_material_expression(mat, unreal.MaterialExpressionTextureCoordinate, -900, -200)
    time = lib.create_material_expression(mat, unreal.MaterialExpressionTime, -900, 0)
    colour = lib.create_material_expression(mat, unreal.MaterialExpressionConstant3Vector, -900, 200)
    colour.set_editor_property('constant', unreal.LinearColor(tint[0], tint[1], tint[2], 1.0))
    size = lib.create_material_expression(mat, unreal.MaterialExpressionConstant, -900, 400)
    size.set_editor_property('r', scale)
    lib.connect_material_expressions(uv, '', custom, 'UV')
    lib.connect_material_expressions(time, '', custom, 'T')
    lib.connect_material_expressions(colour, '', custom, 'Tint')
    lib.connect_material_expressions(size, '', custom, 'Scale')
    lib.connect_material_property(custom, '', unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    lib.recompile_material(mat)
    assets.save_asset(path, only_if_is_dirty=False)
    unreal.log(f'Glitchless demo: made {path}')
