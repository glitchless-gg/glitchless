// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessBugReport.h"

#include "Glitchless.h"
#include "GlitchlessRuntime.h"
#include "Core/GlitchlessJson.h"

#include "Async/Async.h"
#include "Containers/Ticker.h"
#include "GlitchlessStrings.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/PlayerController.h"
#include "GlitchlessSettings.h"
#include "Kismet/GameplayStatics.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Misc/App.h"
#include "Misc/Base64.h"
#include "Modules/ModuleManager.h"
#include "Styling/CoreStyle.h"
#include "UnrealClient.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Text/STextBlock.h"

#define LOCTEXT_NAMESPACE "Glitchless"

namespace
{
	constexpr int32 MaxScreenshotChars = 200000; // what the server keeps (SPEC §2 bug_report); a larger one loses the picture

	// A box filter: each new pixel is the average of the old ones it covers.
	TArray<FColor> Shrink(const TArray<FColor>& Src, int32 Width, int32 Height, int32 NewWidth, int32 NewHeight)
	{
		TArray<FColor> Out;
		Out.SetNumUninitialized(NewWidth * NewHeight);
		for (int32 Y = 0; Y < NewHeight; Y++)
		{
			const int32 Y0 = static_cast<int32>(static_cast<int64>(Y) * Height / NewHeight);
			const int32 Y1 = FMath::Max(Y0 + 1, static_cast<int32>(static_cast<int64>(Y + 1) * Height / NewHeight));
			for (int32 X = 0; X < NewWidth; X++)
			{
				const int32 X0 = static_cast<int32>(static_cast<int64>(X) * Width / NewWidth);
				const int32 X1 = FMath::Max(X0 + 1, static_cast<int32>(static_cast<int64>(X + 1) * Width / NewWidth));
				uint32 R = 0;
				uint32 G = 0;
				uint32 B = 0;
				uint32 N = 0;
				for (int32 SY = Y0; SY < Y1; SY++)
				{
					for (int32 SX = X0; SX < X1; SX++)
					{
						const FColor& C = Src[SY * Width + SX];
						R += C.R;
						G += C.G;
						B += C.B;
						N++;
					}
				}
				Out[Y * NewWidth + X] = FColor(static_cast<uint8>(R / N), static_cast<uint8>(G / N), static_cast<uint8>(B / N), 255);
			}
		}
		return Out;
	}
}

/** The bug report box: a note and Send, over a dimmed game. */
class SGlitchlessBugReport : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SGlitchlessBugReport) {}
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs, Glitchless::FValue InReport)
	{
		Report = MoveTemp(InReport);
		const FSlateBrush* White = FCoreStyle::Get().GetBrush("WhiteBrush");
		ChildSlot
		[
			SNew(SOverlay)
			+ SOverlay::Slot()
			[
				SNew(SBorder)
				.BorderImage(White)
				.BorderBackgroundColor(FLinearColor(0.f, 0.f, 0.f, 0.55f))
			]
			+ SOverlay::Slot()
			.HAlign(HAlign_Center)
			.VAlign(VAlign_Center)
			[
				SNew(SBox)
				.WidthOverride(520.f)
				[
					SNew(SBorder)
					.BorderImage(White)
					.BorderBackgroundColor(FLinearColor(0.035f, 0.04f, 0.05f, 0.97f))
					.Padding(FMargin(24.f))
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot()
						.AutoHeight()
						[
							SNew(STextBlock)
							.Text(LOCTEXT("BugReportTitle", "Report a bug"))
							.Font(FCoreStyle::GetDefaultFontStyle("Bold", 18))
							.ColorAndOpacity(FLinearColor::White)
						]
						+ SVerticalBox::Slot()
						.AutoHeight()
						.Padding(0.f, 6.f, 0.f, 14.f)
						[
							SNew(STextBlock)
							.AutoWrapText(true)
							.Text(LOCTEXT("BugReportHint", "What went wrong? A screenshot of the game goes with your note."))
							.Font(FCoreStyle::GetDefaultFontStyle("Regular", 11))
							.ColorAndOpacity(FLinearColor(0.72f, 0.75f, 0.8f))
						]
						+ SVerticalBox::Slot()
						.AutoHeight()
						[
							SNew(SBox)
							.HeightOverride(120.f)
							[
								SAssignNew(NoteBox, SMultiLineEditableTextBox)
								.HintText(LOCTEXT("BugReportNoteHint", "What happened, and what did you expect?"))
								.Font(FCoreStyle::GetDefaultFontStyle("Regular", 12))
								.AutoWrapText(true)
							]
						]
						+ SVerticalBox::Slot()
						.AutoHeight()
						.HAlign(HAlign_Right)
						.Padding(0.f, 14.f, 0.f, 0.f)
						[
							SNew(SHorizontalBox)
							+ SHorizontalBox::Slot()
							.AutoWidth()
							.Padding(0.f, 0.f, 8.f, 0.f)
							[
								SNew(SButton)
								.Text(LOCTEXT("BugReportCancel", "Cancel"))
								.OnClicked(this, &SGlitchlessBugReport::Cancel)
							]
							+ SHorizontalBox::Slot()
							.AutoWidth()
							[
								SNew(SButton)
								.Text(LOCTEXT("BugReportSend", "Send"))
								.OnClicked(this, &SGlitchlessBugReport::Send)
							]
						]
					]
				]
			]
		];
	}

	virtual bool SupportsKeyboardFocus() const override { return true; }

	virtual FReply OnKeyDown(const FGeometry& MyGeometry, const FKeyEvent& InKeyEvent) override
	{
		if (InKeyEvent.GetKey() == EKeys::Escape)
		{
			return Cancel();
		}
		return SCompoundWidget::OnKeyDown(MyGeometry, InKeyEvent);
	}

	/** Escape cancels and Ctrl+Enter (Cmd+Enter) sends, even while the note has the focus. */
	virtual FReply OnPreviewKeyDown(const FGeometry& MyGeometry, const FKeyEvent& InKeyEvent) override
	{
		if (InKeyEvent.GetKey() == EKeys::Escape)
		{
			return Cancel();
		}
		if (InKeyEvent.GetKey() == EKeys::Enter && (InKeyEvent.IsControlDown() || InKeyEvent.IsCommandDown()))
		{
			return Send();
		}
		return FReply::Unhandled();
	}

	TSharedPtr<SMultiLineEditableTextBox> NoteBox;

private:
	FReply Send()
	{
		const FString Note = NoteBox.IsValid() ? NoteBox->GetText().ToString() : FString();
		if (FGlitchlessRuntime* Runtime = FGlitchlessRuntime::Get())
		{
			Runtime->SendBugReport(MoveTemp(Report), Note);
		}
		GlitchlessBugReport::CloseDialog();
		return FReply::Handled();
	}

	FReply Cancel()
	{
		GlitchlessBugReport::CloseDialog();
		return FReply::Handled();
	}

	Glitchless::FValue Report;
};

namespace
{
	TSharedPtr<SGlitchlessBugReport> OpenDialog;
	TWeakObjectPtr<UGameViewportClient> DialogViewport;
	TWeakObjectPtr<APlayerController> DialogPlayer;
	bool bPlayerHadCursor = false;
	bool bWePaused = false;
}

namespace GlitchlessBugReport
{
	FString EncodeJpegDataUrl(const TArray<FColor>& Pixels, int32 Width, int32 Height, int32 MaxChars, int32& OutWidth, int32& OutHeight)
	{
		OutWidth = 0;
		OutHeight = 0;
		if (Width <= 0 || Height <= 0 || Pixels.Num() != Width * Height)
		{
			return FString();
		}
		IImageWrapperModule& Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
		static const struct
		{
			int32 MaxSide;
			int32 Quality;
		} Steps[] = {{960, 70}, {800, 60}, {640, 60}, {480, 50}, {320, 50}}; // every SDK's sizes
		for (const auto& Step : Steps)
		{
			// The longer side, as the Godot and Unity SDKs do: a phone held upright is taller than wide.
			const double Scale = FMath::Min(1.0, static_cast<double>(Step.MaxSide) / FMath::Max(Width, Height));
			const int32 W = FMath::Max(1, FMath::RoundToInt(Width * Scale));
			const int32 H = FMath::Max(1, FMath::RoundToInt(Height * Scale));
			TArray<FColor> Small = W == Width && H == Height ? Pixels : Shrink(Pixels, Width, Height, W, H);
			TSharedPtr<IImageWrapper> Jpeg = Module.CreateImageWrapper(EImageFormat::JPEG);
			if (!Jpeg.IsValid() || !Jpeg->SetRaw(Small.GetData(), Small.Num() * sizeof(FColor), W, H, ERGBFormat::BGRA, 8))
			{
				return FString();
			}
			const TArray64<uint8> Bytes = Jpeg->GetCompressed(Step.Quality);
			const FString Url = FString(TEXT("data:image/jpeg;base64,")) + FBase64::Encode(Bytes.GetData(), static_cast<uint32>(Bytes.Num()));
			if (Url.Len() <= MaxChars)
			{
				OutWidth = W;
				OutHeight = H;
				return Url;
			}
		}
		return FString();
	}

	// The report waiting for its screenshot: Unreal reads the viewport as it draws the next frame,
	// the one moment every RHI has the picture (reading it at any other time trips Metal).
	struct FPending
	{
		Glitchless::FValue Report;
		FString Note;
		bool bDialog = false;
	};

	static TArray<FPending> Pending;
	static FDelegateHandle CapturedHandle;
	static FTSTicker::FDelegateHandle TimeoutHandle;

	static void OpenBox(Glitchless::FValue Report)
	{
		UGameViewportClient* Viewport = GEngine ? GEngine->GameViewport.Get() : nullptr;
		if (OpenDialog.IsValid() || !Viewport)
		{
			return;
		}
		TSharedRef<SGlitchlessBugReport> Dialog = SNew(SGlitchlessBugReport, MoveTemp(Report));
		Viewport->AddViewportWidgetContent(Dialog, 10000);
		OpenDialog = Dialog;
		DialogViewport = Viewport;
		APlayerController* Player = Viewport->GetWorld() ? Viewport->GetWorld()->GetFirstPlayerController() : nullptr;
		DialogPlayer = Player;
		if (Player)
		{
			bPlayerHadCursor = Player->bShowMouseCursor;
			Player->bShowMouseCursor = true;
			FInputModeUIOnly Mode;
			Mode.SetWidgetToFocus(Dialog->NoteBox);
			Mode.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock);
			Player->SetInputMode(Mode);
		}
		else if (FSlateApplication::IsInitialized())
		{
			FSlateApplication::Get().SetAllUserFocus(Dialog->NoteBox, EFocusCause::SetDirectly);
		}
		// The game waits behind the box, unless it was paused already or can't be (a network client).
		UWorld* World = Viewport->GetWorld();
		bWePaused = false;
		if (World && GetDefault<UGlitchlessSettings>()->bPauseForBugReport && !UGameplayStatics::IsGamePaused(World))
		{
			bWePaused = UGameplayStatics::SetGamePaused(World, true);
		}
		FGlitchless::OnBugReportDialog().Broadcast(true);
	}

	// The screenshot is here (or isn't coming): every waiting report gets it, then is sent or shown.
	static void Finish(const FString& Screenshot)
	{
		UGameViewportClient::OnScreenshotCaptured().Remove(CapturedHandle);
		CapturedHandle.Reset();
		FTSTicker::GetCoreTicker().RemoveTicker(TimeoutHandle);
		TimeoutHandle.Reset();
		TArray<FPending> Taken = MoveTemp(Pending);
		Pending.Reset();
		FGlitchlessRuntime* Runtime = FGlitchlessRuntime::Get();
		if (!Runtime)
		{
			return;
		}
		// The frame that read the viewport back was Glitchless's, not the game's, and so is the box's first draw.
		const bool bOpensBox = Taken.ContainsByPredicate([](const FPending& P) { return P.bDialog; });
		Runtime->SkipNextFrames(bOpensBox ? 2 : 1);
		const std::string Shot = GlitchlessText::Utf8(Screenshot);
		for (FPending& P : Taken)
		{
			if (!Shot.empty())
			{
				P.Report.Set("screenshot", Shot);
			}
			if (P.bDialog)
			{
				OpenBox(MoveTemp(P.Report));
			}
			else
			{
				Runtime->SendBugReport(MoveTemp(P.Report), P.Note);
			}
		}
	}

	static void OnCaptured(int32 Width, int32 Height, const TArray<FColor>& Colors)
	{
		int32 W = 0;
		int32 H = 0;
		Finish(EncodeJpegDataUrl(Colors, Width, Height, MaxScreenshotChars, W, H));
	}

	static void Capture(FPending Report)
	{
		Pending.Add(MoveTemp(Report));
		if (CapturedHandle.IsValid())
		{
			return; // a screenshot is on its way already
		}
		if (!FApp::CanEverRender() || !GEngine || !GEngine->GameViewport)
		{
			Finish(FString());
			return;
		}
		CapturedHandle = UGameViewportClient::OnScreenshotCaptured().AddStatic(&OnCaptured);
		FScreenshotRequest::RequestScreenshot(true, true); // with the game's UI, of the game's viewport only
		// A viewport that doesn't draw (minimised, a headless run) never answers: send without a picture.
		TimeoutHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([](float) {
			Finish(FString());
			return false;
		}), 2.0f);
	}

	void Report(const FString& Note)
	{
		if (!IsInGameThread())
		{
			AsyncTask(ENamedThreads::GameThread, [Note]() { Report(Note); });
			return;
		}
		if (FGlitchlessRuntime* Runtime = FGlitchlessRuntime::Get())
		{
			Capture(FPending{Runtime->MakeBugReport(FString()), Note, false});
		}
	}

	void ShowDialog()
	{
		if (!IsInGameThread())
		{
			AsyncTask(ENamedThreads::GameThread, []() { ShowDialog(); });
			return;
		}
		FGlitchlessRuntime* Runtime = FGlitchlessRuntime::Get();
		if (OpenDialog.IsValid() || !Runtime || Pending.ContainsByPredicate([](const FPending& P) { return P.bDialog; }))
		{
			return;
		}
		// The report describes what the player saw when they asked, not when they pressed Send; the box
		// opens once the screenshot is taken, so it isn't in it.
		Capture(FPending{Runtime->MakeBugReport(FString()), FString(), true});
	}

	void CloseDialog()
	{
		if (!OpenDialog.IsValid())
		{
			return;
		}
		TSharedRef<SGlitchlessBugReport> Dialog = OpenDialog.ToSharedRef();
		OpenDialog.Reset();
		if (UGameViewportClient* Viewport = DialogViewport.Get())
		{
			Viewport->RemoveViewportWidgetContent(Dialog);
		}
		// Back to how the game had it: a game that showed a cursor (a menu) keeps it, a paused game stays paused.
		if (UGameViewportClient* Viewport = DialogViewport.Get())
		{
			if (bWePaused && Viewport->GetWorld())
			{
				UGameplayStatics::SetGamePaused(Viewport->GetWorld(), false);
			}
		}
		bWePaused = false;
		if (APlayerController* Player = DialogPlayer.Get())
		{
			Player->bShowMouseCursor = bPlayerHadCursor;
			if (bPlayerHadCursor)
			{
				Player->SetInputMode(FInputModeGameAndUI());
			}
			else
			{
				Player->SetInputMode(FInputModeGameOnly());
			}
		}
		DialogViewport.Reset();
		DialogPlayer.Reset();
		FGlitchless::OnBugReportDialog().Broadcast(false);
	}

	bool IsDialogOpen()
	{
		return OpenDialog.IsValid();
	}
}

#undef LOCTEXT_NAMESPACE
